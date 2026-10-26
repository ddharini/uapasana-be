import crypto from "crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../utils/db";
import { registrationIdFor } from "./whatsapp-log";

/**
 * What Meta tells us after a message is sent: delivery statuses for what we
 * sent, and the messages devotees send to our number. Arrives at
 * POST /api/webhooks/whatsapp (src/routes/webhookRoutes.ts).
 *
 * Three things shape this file:
 *
 * - **Only Meta may write here.** Every POST is signed with the app secret
 *   (`X-Hub-Signature-256`, HMAC-SHA256 of the exact bytes sent), so the route
 *   keeps the raw body and `verifySignature` checks it before anything is read.
 * - **Meta repeats itself and changes the order.** The same event can arrive
 *   twice, and "read" can land before "delivered". A status only ever moves a
 *   message forward (`statusRank`), and an inbound message is keyed by its
 *   unique Meta id, so replaying any webhook changes nothing.
 * - **Meta wants a quick 200.** A slow answer is retried and, if it keeps
 *   happening, the subscription is switched off. The route answers first and
 *   calls `processWebhook` after; a failure here is logged, never answered.
 */

/** A status update, as much of it as we keep. */
export type StatusEvent = {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: Date;
  errorCode?: number;
  errorMessage?: string;
};

/** One message a devotee sent us. */
export type InboundEvent = {
  waMessageId: string;
  from: string;
  profileName?: string;
  type: string;
  text?: string;
  raw: Prisma.InputJsonValue;
  receivedAt: Date;
};

/**
 * Whether `header` ("sha256=<hex>") is Meta's signature of `rawBody` under
 * `secret`. Constant-time, and false — never a throw — for anything malformed.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string
): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * How far along a message is. A webhook may only raise it: "failed" outranks
 * everything because a failure is final, and "accepted" — Meta took the
 * request — is where every logged message starts.
 */
export const statusRank: Record<string, number> = {
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/** Meta's timestamps are seconds since the epoch, as strings. */
const fromUnix = (value: unknown) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
};

/** Meta's JSON, read defensively: every field is checked before it is used. */
type Raw = Record<string, any>;

/** The words in a message, whatever kind it is; undefined for a sticker or a voice note. */
function textOf(message: Raw): string | undefined {
  const text =
    message.text?.body ??
    message.button?.text ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    message.image?.caption ??
    message.video?.caption ??
    message.document?.caption ??
    message.document?.filename ??
    message.reaction?.emoji ??
    (message.location
      ? [message.location.name, message.location.address].filter(Boolean).join(", ") || "Location"
      : undefined);
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 4096) : undefined;
}

/**
 * Pulls the statuses and inbound messages out of one webhook body. Anything
 * about another phone number is left out: the app can be subscribed to a
 * business account with more than one number, and only `phoneNumberId` is ours.
 * Other kinds of event (template reviews, quality changes) are returned as
 * `notices` for the log.
 */
export function parseWebhook(body: unknown, phoneNumberId?: string) {
  const statuses: StatusEvent[] = [];
  const inbound: InboundEvent[] = [];
  const notices: string[] = [];
  const root = (body ?? {}) as Raw;
  if (root.object !== "whatsapp_business_account") return { statuses, inbound, notices };

  for (const entry of Array.isArray(root.entry) ? root.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = (change?.value ?? {}) as Raw;
      if (change?.field !== "messages") {
        notices.push(`${change?.field ?? "unknown"}: ${JSON.stringify(value).slice(0, 500)}`);
        continue;
      }
      if (
        phoneNumberId &&
        value.metadata?.phone_number_id &&
        value.metadata.phone_number_id !== phoneNumberId
      ) {
        continue;
      }

      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (typeof status?.id !== "string" || !STATUSES.has(status.status)) continue;
        const error = Array.isArray(status.errors) ? status.errors[0] : undefined;
        statuses.push({
          waMessageId: status.id,
          status: status.status,
          at: fromUnix(status.timestamp),
          ...(error
            ? {
                errorCode: Number(error.code) || undefined,
                errorMessage:
                  String(error.error_data?.details ?? error.message ?? error.title ?? "").slice(
                    0,
                    500
                  ) || undefined,
              }
            : {}),
        });
      }

      const contacts: Raw[] = Array.isArray(value.contacts) ? value.contacts : [];
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        if (typeof message?.id !== "string" || typeof message?.from !== "string") continue;
        const contact = contacts.find(c => c?.wa_id === message.from);
        inbound.push({
          waMessageId: message.id,
          from: message.from.replace(/\D/g, ""),
          profileName: contact?.profile?.name || undefined,
          type: String(message.type ?? "unknown"),
          text: textOf(message),
          raw: message as Prisma.InputJsonValue,
          receivedAt: fromUnix(message.timestamp),
        });
      }
    }
  }
  return { statuses, inbound, notices };
}

const TIMESTAMP_FIELD = {
  sent: "sentAt",
  delivered: "deliveredAt",
  read: "readAt",
  failed: "failedAt",
} as const;

/** "null or absent": Prisma writes no optional field nobody set, and Mongo's null does not match a missing key. */
const unset = (field: string) => ({ OR: [{ [field]: null }, { [field]: { isSet: false } }] });

/**
 * Applies one status. Two conditional writes, each safe to repeat: the time of
 * this step is recorded once, and the status moves only if it is a step
 * forward. A status for a message we never logged (sent from Meta's dashboard,
 * say) matches nothing and is ignored.
 */
async function applyStatus(event: StatusEvent) {
  const field = TIMESTAMP_FIELD[event.status];
  await prisma.whatsAppMessage.updateMany({
    where: { waMessageId: event.waMessageId, ...unset(field) },
    data: { [field]: event.at },
  });
  const behind = Object.keys(statusRank).filter(s => statusRank[s] < statusRank[event.status]);
  await prisma.whatsAppMessage.updateMany({
    where: { waMessageId: event.waMessageId, status: { in: behind } },
    data: {
      status: event.status,
      ...(event.status === "failed"
        ? { errorCode: event.errorCode ?? null, errorMessage: event.errorMessage ?? null }
        : {}),
    },
  });
  if (event.status === "failed") {
    console.warn(
      `[WhatsApp] ${event.waMessageId} failed: ${event.errorCode ?? "?"} ${event.errorMessage ?? ""}`
    );
  }
}

async function storeInbound(event: InboundEvent) {
  try {
    await prisma.whatsAppInbound.create({
      data: { ...event, registrationId: (await registrationIdFor(event.from)) ?? null },
    });
  } catch (error) {
    // Already stored: Meta delivered this webhook before.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
}

/** Stores everything in one webhook body. Each event is independent; one failing does not stop the rest. */
export async function processWebhook(body: unknown) {
  const { statuses, inbound, notices } = parseWebhook(
    body,
    process.env.WA_PHONE_NUMBER_ID || undefined
  );
  for (const notice of notices) console.log(`[WhatsApp] Notice — ${notice}`);
  const results = await Promise.allSettled([
    ...statuses.map(applyStatus),
    ...inbound.map(storeInbound),
  ]);
  for (const result of results) {
    if (result.status === "rejected")
      console.error("[WhatsApp] Could not store a webhook event:", result.reason);
  }
}
