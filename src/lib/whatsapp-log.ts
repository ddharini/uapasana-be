import { prisma } from "../utils/db";

/**
 * The record of what we sent on WhatsApp (`WhatsAppMessage`), so the delivery
 * webhook has something to move along and admins can see what became of a
 * message. Kept apart from src/lib/whatsapp.ts so sending never depends on it.
 */

/** The registration a number is the contact for, if any. Stored numbers are E.164; `digits` has no "+". */
export async function registrationIdFor(digits: string): Promise<string | undefined> {
  const registration = await prisma.registration.findFirst({
    where: { contactMobile: `+${digits}` },
    select: { id: true },
  });
  return registration?.id;
}

/**
 * Records one send Meta accepted. Never throws, for the same reason
 * `recordUsage` does not: the message has already gone, and failing the
 * request now would only make whoever asked send it again.
 */
export async function logSentMessage(entry: {
  waMessageId: string;
  to: string;
  template: string;
  language: string;
  purpose: string;
}): Promise<void> {
  try {
    await prisma.whatsAppMessage.create({
      data: { ...entry, registrationId: (await registrationIdFor(entry.to)) ?? null },
    });
  } catch (error) {
    console.error(`[WhatsApp] Could not log ${entry.waMessageId}:`, error);
  }
}
