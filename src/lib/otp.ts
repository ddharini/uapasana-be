import crypto from "crypto";
import { z } from "zod";

import { prisma } from "../utils/db";
import { MOBILE_E164 } from "./event";
import { WHATSAPP_LANGS } from "./whatsapp";

/**
 * Mobile number verification: one-time codes, and the token that proves a
 * number was verified.
 *
 * Codes are sent on WhatsApp through Meta's Cloud API (src/lib/whatsapp.ts),
 * using an Authentication template, in the language the form is shown in. The
 * rate limits below are counted from the `PhoneVerification` rows themselves,
 * so they need no extra store, and they matter: the endpoint is public, and
 * every code sent is paid for.
 */

/**
 * Whether a new registration's contact number needs a WhatsApp code. Off from
 * 2026-10-13 to 2026-10-23 while WhatsApp was not set up; registrations saved
 * then have `mobileVerification` null. Off, devotees editing their own
 * registration (/register/edit) still need a code — that is what keeps one
 * devotee out of another's details. Change together with MOBILE_OTP_REQUIRED
 * in upasana-fe/src/features/registrations/form/schema.ts.
 */
export const MOBILE_OTP_REQUIRED = true;

/** How long a code works. */
export const OTP_TTL_MINUTES = 10;
/** Wrong guesses before a code stops working and a new one is needed. */
export const OTP_MAX_ATTEMPTS = 5;
/** Minimum gap between two codes to the same number. */
export const OTP_RESEND_SECONDS = 30;
/** Codes per number per hour. */
export const OTP_MAX_PER_NUMBER_PER_HOUR = 5;
/**
 * Codes per hour across everyone: a ceiling on what a script cycling through
 * numbers can spend on Meta's invoice. Well above any real registration
 * rush. Not per IP on purpose — behind a reverse proxy without `trust proxy`,
 * every visitor shares the proxy's address, and a per-IP limit would quietly
 * become this one at a far lower number.
 */
export const otpMaxPerHour = () => Number(process.env.OTP_MAX_PER_HOUR) || 500;
/** How long a verified number stays verified for submitting the form. */
export const OTP_TOKEN_TTL_HOURS = 2;

export const sendOtpSchema = z.object({
  mobile: z.string().trim().regex(MOBILE_E164, "Enter a valid mobile number with country code"),
  /** The language the form is shown in, so the code arrives in it too. */
  lang: z.enum(WHATSAPP_LANGS).optional(),
});

export const verifyOtpSchema = z.object({
  mobile: z.string().trim().regex(MOBILE_E164, "Enter a valid mobile number with country code"),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

/** Six digits, leading zeros kept. `randomInt` is uniform; `Math.random` is not a secret. */
export function newOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Keyed with the server secret and bound to the number, so a code entered for
 * one number cannot match a row for another, and a leaked row is useless.
 */
export function hashOtpCode(mobile: string, code: string) {
  const secret = process.env.BETTER_AUTH_SECRET || "dev-secret";
  return crypto.createHmac("sha256", secret).update(`${mobile}:${code}`).digest("hex");
}

export function newVerificationToken() {
  const token = crypto.randomBytes(24).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Constant-time compare of two hex digests of equal length. */
export function sameHash(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** The usable-token filter shared by `peek` and `consume`. */
const usableToken = (token: string, mobile: string) => ({
  tokenHash: hashToken(token),
  mobile,
  tokenExpiresAt: { gt: new Date() },
  OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
});

/**
 * Whether `token` proves `mobile` was verified and is still unused — without
 * using it up. For reading the devotee's own registrations before they edit
 * one; the edit itself then spends it.
 */
export async function peekVerificationToken(token: string, mobile: string): Promise<boolean> {
  return (await prisma.phoneVerification.count({ where: usableToken(token, mobile) })) === 1;
}

/**
 * Spends a verification token on a registration: true when `token` proves
 * `mobile` was verified within the last OTP_TOKEN_TTL_HOURS and has not been
 * used yet.
 *
 * One conditional update, so two submits racing with the same token cannot
 * both succeed. `consumedAt` is matched as null *or absent*: Prisma does not
 * write an optional field nobody set, and on MongoDB `null` alone does not
 * match a missing key (the trap documented in src/utils/locks.ts).
 */
export async function consumeVerificationToken(token: string, mobile: string): Promise<boolean> {
  const { count } = await prisma.phoneVerification.updateMany({
    where: usableToken(token, mobile),
    data: { consumedAt: new Date() },
  });
  return count === 1;
}
