import { Request, Response } from "express";

import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_PER_NUMBER_PER_HOUR,
  OTP_RESEND_SECONDS,
  OTP_TOKEN_TTL_HOURS,
  OTP_TTL_MINUTES,
  hashOtpCode,
  newOtpCode,
  newVerificationToken,
  otpMaxPerHour,
  sameHash,
  sendOtpSchema,
  verifyOtpSchema,
} from "../lib/otp";
import { registrationsWithNumbers, toNumberUseSummary } from "../lib/number-in-use";
import { toRegistrationSummary } from "../lib/registrations";
import { WHATSAPP_TEMPLATES, isWhatsAppConfigured, sendWhatsAppTemplate } from "../lib/whatsapp";
import { prisma } from "../utils/db";

/**
 * Mobile verification for the registration form. Public: devotees register
 * without an account.
 *
 *   POST /otp/send     { mobile }        a code on WhatsApp
 *   POST /otp/verify   { mobile, code }  → { verificationToken, existing, listed }
 *
 * The token goes into the registration request; registrationController spends
 * it. See `PhoneVerification` in schema.prisma for the whole flow.
 */

const MINUTE = 60_000;
const isProduction = () => process.env.NODE_ENV === "production";

function fail(res: Response, status: number, code: string, message: string, extra: object = {}) {
  res.status(status).json({ success: false, code, message, ...extra });
}

const send = async (req: Request, res: Response): Promise<void> => {
  const parsed = sendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return fail(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid number");
  }
  const { mobile, lang } = parsed.data;

  // Without WhatsApp the code cannot reach anyone. In development it is logged
  // and returned instead, so the form can be tried before WhatsApp is set up;
  // in production that would hand the code to whoever asked, so it refuses.
  const deliverable = isWhatsAppConfigured();
  if (!deliverable && isProduction()) {
    return fail(res, 503, "OTP_UNAVAILABLE", "Verification codes cannot be sent right now. Please try again later.");
  }

  const now = Date.now();
  const hourAgo = new Date(now - 60 * MINUTE);
  const [last, sentToNumber, sentOverall] = await Promise.all([
    prisma.phoneVerification.findFirst({ where: { mobile }, orderBy: { createdAt: "desc" } }),
    prisma.phoneVerification.findMany({
      where: { mobile, createdAt: { gt: hourAgo } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.phoneVerification.count({ where: { createdAt: { gt: hourAgo } } }),
  ]);

  const waitSeconds = last
    ? Math.ceil((last.createdAt.getTime() + OTP_RESEND_SECONDS * 1000 - now) / 1000)
    : 0;
  if (waitSeconds > 0) {
    return fail(res, 429, "OTP_COOLDOWN", `Wait ${waitSeconds} seconds before asking for another code.`, {
      retryAfterSeconds: waitSeconds,
    });
  }
  if (sentToNumber.length >= OTP_MAX_PER_NUMBER_PER_HOUR) {
    // The window is rolling, so the wait is until the oldest code in it is an
    // hour old — not "an hour", which devotees read as an hour from now and
    // then, trying after thirty minutes, found still refused.
    const freesAt = sentToNumber[0].createdAt.getTime() + 60 * MINUTE;
    const minutes = Math.max(1, Math.ceil((freesAt - now) / MINUTE));
    return fail(
      res,
      429,
      "OTP_LIMIT",
      `Too many codes sent to this number. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
      { retryAfterSeconds: Math.ceil((freesAt - now) / 1000) }
    );
  }
  if (sentOverall >= otpMaxPerHour()) {
    console.error(`[OTP] Hourly cap of ${otpMaxPerHour()} codes reached — refusing sends.`);
    return fail(res, 429, "OTP_BUSY", "Too many verification requests right now. Please try again shortly.");
  }

  const code = newOtpCode();
  const record = await prisma.phoneVerification.create({
    data: {
      mobile,
      codeHash: hashOtpCode(mobile, code),
      expiresAt: new Date(now + OTP_TTL_MINUTES * MINUTE),
    },
  });

  if (deliverable) {
    try {
      await sendWhatsAppTemplate({
        to: mobile,
        template: WHATSAPP_TEMPLATES.otp(),
        lang,
        // Authentication templates carry the code twice: in the body and as
        // the value of the "Copy code" button.
        body: [code],
        buttonUrl: code,
        usage: { endpoint: "whatsapp:otp" },
      });
    } catch (error) {
      console.error(`[OTP] WhatsApp code to ${mobile} failed:`, error);
      // Not counted against the cooldown or the hourly limit: nothing arrived.
      await prisma.phoneVerification.delete({ where: { id: record.id } });
      return fail(
        res,
        502,
        "OTP_SEND_FAILED",
        "We could not send the code on WhatsApp. Check that this number uses WhatsApp, then try again."
      );
    }
  } else {
    console.warn(`[OTP] WhatsApp is not configured. Development code for ${mobile}: ${code}`);
  }

  res.status(200).json({
    success: true,
    data: {
      expiresInSeconds: OTP_TTL_MINUTES * 60,
      resendAfterSeconds: OTP_RESEND_SECONDS,
      ...(deliverable ? {} : { devCode: code }),
    },
  });
};

const verify = async (req: Request, res: Response): Promise<void> => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return fail(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid code");
  }
  const { mobile, code } = parsed.data;

  // Every unexpired, unused code for the number works — not only the newest.
  // Retiring the old code on each resend was the commonest way devotees
  // failed: WhatsApp is slow, they asked again, then typed the code that had
  // arrived first (or the one their keyboard offered from an earlier
  // message), were told it was wrong, asked again, and ran into the hourly
  // limit within minutes. Measured on 2026-11-18. The guessing odds barely
  // move: at most OTP_MAX_PER_NUMBER_PER_HOUR live codes, each a one-in-a-
  // million target, behind the same OTP_MAX_ATTEMPTS.
  const [newest, live] = await Promise.all([
    prisma.phoneVerification.findFirst({ where: { mobile }, orderBy: { createdAt: "desc" } }),
    prisma.phoneVerification.findMany({
      where: {
        mobile,
        expiresAt: { gt: new Date() },
        OR: [{ verifiedAt: null }, { verifiedAt: { isSet: false } }],
      },
      orderBy: { createdAt: "desc" },
      take: OTP_MAX_PER_NUMBER_PER_HOUR,
    }),
  ]);

  // Wrong guesses are counted on the newest live code, so one budget of
  // OTP_MAX_ATTEMPTS covers every code in play and a resend renews it.
  const record = live[0];
  if (!record) {
    return newest?.verifiedAt
      ? fail(res, 400, "OTP_EXPIRED", "This code has already been used. Send a new one.")
      : fail(res, 400, "OTP_EXPIRED", "This code has expired. Send a new one.");
  }
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    return fail(res, 429, "OTP_TOO_MANY_ATTEMPTS", "Too many wrong codes. Send a new one.");
  }

  const codeHash = hashOtpCode(mobile, code);
  const match = live.find((r) => sameHash(r.codeHash, codeHash));
  if (!match) {
    const attempts = record.attempts + 1;
    await prisma.phoneVerification.update({ where: { id: record.id }, data: { attempts } });
    const left = OTP_MAX_ATTEMPTS - attempts;
    return fail(
      res,
      400,
      "OTP_WRONG",
      left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Send a new one."
    );
  }

  const { token, tokenHash } = newVerificationToken();
  // Conditional on still being unverified, so the same code entered twice at
  // once yields one token, not two.
  const { count } = await prisma.phoneVerification.updateMany({
    where: { id: match.id, OR: [{ verifiedAt: null }, { verifiedAt: { isSet: false } }] },
    data: {
      verifiedAt: new Date(),
      tokenHash,
      tokenExpiresAt: new Date(Date.now() + OTP_TOKEN_TTL_HOURS * 60 * MINUTE),
    },
  });
  if (count === 0) {
    return fail(res, 400, "OTP_EXPIRED", "This code has already been used. Send a new one.");
  }

  // The registration this number is already the contact for (one per number),
  // so the form can stop and offer to change that one instead. Safe to show:
  // the code just proved the number is theirs.
  const existing = await prisma.registration.findMany({
    where: { contactMobile: mobile },
    orderBy: { createdAt: "desc" },
  });

  // Where else this number is used — typed against a family member, not as
  // the contact (that is `existing`). One number, one registration
  // (lib/number-in-use.ts): the form stops on it and says which registration
  // and whose entry, so they know whom to ask. Safe for the same reason as
  // `existing`: the code just proved the number is theirs.
  const listed = (await registrationsWithNumbers([mobile]))
    .filter((r) => r.contactMobile !== mobile)
    .flatMap((r) => r.members.filter((m) => m.mobile === mobile).map((m) => toNumberUseSummary(r, m, true)));

  res.status(200).json({
    success: true,
    data: {
      verificationToken: token,
      existing: existing.map((r) => toRegistrationSummary(r, true)),
      listed,
    },
  });
};

export const otpController = { send, verify };
