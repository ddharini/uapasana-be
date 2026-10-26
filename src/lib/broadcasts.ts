import type { Registration } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../utils/db";
import {
  WhatsAppSendError,
  WhatsAppUnavailableError,
  sendWhatsAppTemplate,
  toWhatsAppNumber,
  type MetaTemplate,
} from "./whatsapp";

/**
 * Send messages (/admin/messages): one WhatsApp template to many registered
 * devotees at once, each copy filled in for that person.
 *
 * What WhatsApp allows decides the shape. A business may only start a chat
 * with a template Meta approved, so a "custom message" is an approved template
 * with a slot for free text (WA_TEMPLATE_ANNOUNCEMENT); every other approved
 * template can be sent too. A template's blanks ({{1}}, {{2}}…) are filled per
 * person from `VariableSpec`s: their name, their DM number, or text the admin
 * typed.
 *
 * Who gets it is chosen on the screen with the Reports filters; the browser
 * sends the people it chose, and the server reads their numbers itself from
 * the registrations — never from the request — leaving out dummy
 * registrations, people without a number and numbers already on the list.
 */

/** Most numbers one send may go to. Far above any one mandal; a safety stop, not a plan. */
export const MAX_RECIPIENTS = 5000;
/** Most characters typed into one blank. Meta caps the whole message at 1024. */
export const MAX_TEXT_LENGTH = 700;
/** Meta's limit on a template body once its blanks are filled. */
const BODY_LIMIT = 1024;
/** Gap between two sends: ~6 a second, far below what Meta allows, gentle on its spam checks. */
const PACE_MS = 150;
/** Failures in a row that pause a send, so a dead token or a used-up daily limit stops early. */
const PAUSE_AFTER_FAILURES = 10;

/** The template with a slot for free text — the "custom message". */
export const announcementTemplate = () => process.env.WA_TEMPLATE_ANNOUNCEMENT || "anoopam_update";
/**
 * Different people Meta lets this number start a chat with per 24 hours:
 * 250 until the business is verified, then 2,000 and up. Meta does not report
 * it through the API, so it is set by hand (WA_DAILY_LIMIT) and only used to
 * warn before a send that would go past it.
 */
export const dailyLimit = () => Number(process.env.WA_DAILY_LIMIT) || 250;

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/** One language of a template that can be sent from here. */
export type SendableLanguage = {
  code: string;
  header?: string;
  body: string;
  footer?: string;
  /** Labels of its buttons, for the preview. */
  buttons: string[];
  /** How many blanks the body has: {{1}} … {{n}}. */
  variables: number;
};

export type SendableTemplate = {
  name: string;
  category: string;
  languages: SendableLanguage[];
};

/**
 * The templates that can be sent from here, grouped by name: approved,
 * Utility or Marketing (codes are sent by the registration form, not from
 * here), numbered blanks, and blanks in the body only. A blank in a header or
 * a button, or a picture header, needs a value this screen does not collect,
 * so those templates are left out rather than failing on send.
 */
export function sendableTemplates(templates: MetaTemplate[]): SendableTemplate[] {
  const byName = new Map<string, SendableTemplate>();
  for (const t of templates) {
    if (t.status !== "APPROVED" || !["UTILITY", "MARKETING"].includes(t.category)) continue;
    if (t.parameter_format && t.parameter_format !== "POSITIONAL") continue;
    const header = t.components.find(c => c.type === "HEADER");
    const body = t.components.find(c => c.type === "BODY");
    const footer = t.components.find(c => c.type === "FOOTER");
    const buttons = t.components.find(c => c.type === "BUTTONS")?.buttons ?? [];
    if (!body?.text) continue;
    if (header && (header.format !== "TEXT" || /\{\{/.test(header.text ?? ""))) continue;
    if (buttons.some(b => /\{\{/.test(b.url ?? ""))) continue;

    const numbers = [...body.text.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
    const language: SendableLanguage = {
      code: t.language,
      header: header?.text,
      body: body.text,
      footer: footer?.text,
      buttons: buttons.map(b => b.text ?? "").filter(Boolean),
      variables: numbers.length ? Math.max(...numbers) : 0,
    };
    const entry = byName.get(t.name) ?? { name: t.name, category: t.category, languages: [] };
    entry.languages.push(language);
    byName.set(t.name, entry);
  }
  // The custom-message template first, then by name.
  const first = announcementTemplate();
  return [...byName.values()].sort(
    (a, b) => Number(b.name === first) - Number(a.name === first) || a.name.localeCompare(b.name)
  );
}

/* ------------------------------------------------------------------ */
/* What fills each blank                                               */
/* ------------------------------------------------------------------ */

export const VARIABLE_SOURCES = {
  name: "Their full name",
  firstName: "Their first name",
  dmNumber: "Their DM number",
  registrationNumber: "Registration number (DM-F for a family)",
  mandal: "Their mandal",
  text: "Text you type",
} as const;

export const variableSpecSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.enum(["name", "firstName", "dmNumber", "registrationNumber", "mandal"]),
  }),
  z.object({
    source: z.literal("text"),
    text: z
      .string()
      .transform(value => cleanParam(value))
      .pipe(
        z
          .string()
          .min(1, "Type the text for this blank")
          .max(MAX_TEXT_LENGTH, `At most ${MAX_TEXT_LENGTH} characters`)
      ),
  }),
]);
export type VariableSpec = z.infer<typeof variableSpecSchema>;

/**
 * A value as Meta accepts it inside a template: no line breaks or tabs, and
 * no run of more than four spaces (error 132018). Line breaks become a space,
 * so a typed paragraph still reads as one.
 */
export function cleanParam(text: string) {
  return text
    .replace(/\s*[\r\n\t]+\s*/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

type Member = Registration["members"][number];

/** One blank for one person. Never empty: Meta refuses an empty value. */
export function valueFor(spec: VariableSpec, registration: Registration, member: Member) {
  const value = (() => {
    switch (spec.source) {
      case "name":
        return member.fullName;
      case "firstName":
        return member.firstName || member.fullName.split(" ")[0];
      case "dmNumber":
        return member.code || registration.code;
      case "registrationNumber":
        return registration.code;
      case "mandal":
        return registration.mandal;
      case "text":
        return spec.text;
    }
  })();
  return cleanParam(value ?? "") || registration.code;
}

/** The body with its blanks filled, as the devotee will read it. */
export function renderBody(body: string, values: string[]) {
  return body.replace(/\{\{(\d+)\}\}/g, (all, n) => values[Number(n) - 1] ?? all);
}

/* ------------------------------------------------------------------ */
/* Who gets it                                                         */
/* ------------------------------------------------------------------ */

export const pickSchema = z.object({
  registrationId: z.string().regex(/^[a-f\d]{24}$/i),
  memberId: z.string().min(1).max(40),
});
export type Pick = z.infer<typeof pickSchema>;

export type Recipient = {
  order: number;
  to: string;
  name: string;
  registrationId: string;
  memberId: string;
  values: string[];
};

export type Skipped = { noNumber: number; duplicate: number; invalid: number; notFound: number };

/**
 * The numbers a send goes to, in the order the people were picked, with each
 * person's values. Every person with a mobile gets it once: a number that
 * appears twice (a parent's on a child's line) goes to whoever came first. Dummy
 * registrations are never messaged, whatever the browser sent — their numbers
 * are made up and may belong to real people.
 */
export function chooseRecipients(
  registrations: Registration[],
  picks: Pick[],
  specs: VariableSpec[],
  body: string
): { recipients: Recipient[]; skipped: Skipped; tooLong?: string } {
  const byId = new Map(registrations.filter(r => !r.isSample).map(r => [r.id, r]));
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  const skipped: Skipped = { noNumber: 0, duplicate: 0, invalid: 0, notFound: 0 };
  let tooLong: string | undefined;

  for (const pick of picks) {
    const registration = byId.get(pick.registrationId);
    const member = registration?.members.find(m => m.id === pick.memberId);
    if (!registration || !member) {
      skipped.notFound++;
      continue;
    }
    if (!member.mobile) {
      skipped.noNumber++;
      continue;
    }
    let to: string;
    try {
      to = toWhatsAppNumber(member.mobile);
    } catch {
      skipped.invalid++;
      continue;
    }
    if (seen.has(to)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(to);
    const values = specs.map(spec => valueFor(spec, registration, member));
    if (!tooLong && renderBody(body, values).length > BODY_LIMIT) tooLong = member.fullName;
    recipients.push({
      order: recipients.length,
      to,
      name: member.fullName,
      registrationId: registration.id,
      memberId: member.id,
      values,
    });
  }
  return { recipients, skipped, tooLong };
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Broadcasts being sent by this process right now, so one is never sent twice at once. */
const running = new Set<string>();

/** Starts (or carries on) sending a broadcast in the background. Safe to call twice. */
export function startBroadcast(id: string) {
  if (running.has(id)) return;
  running.add(id);
  runBroadcast(id)
    .catch(error => console.error(`[Broadcast] ${id} stopped:`, error))
    .finally(() => running.delete(id));
}

async function pause(id: string, reason: string) {
  console.warn(`[Broadcast] ${id} paused: ${reason}`);
  await prisma.whatsAppBroadcast.updateMany({
    where: { id, status: "sending" },
    data: { status: "paused", pauseReason: reason },
  });
}

/**
 * Sends a broadcast's pending recipients one by one until none are left, an
 * admin stops or pauses it, or too many fail in a row. Each recipient is
 * claimed (`pending` → `sending`) before its message goes, so a second runner
 * — another server, a double start — skips it rather than sending it again.
 */
export async function runBroadcast(id: string) {
  let failuresInARow = 0;
  for (;;) {
    const broadcast = await prisma.whatsAppBroadcast.findUnique({ where: { id } });
    if (!broadcast || broadcast.status !== "sending") return;

    const next = await prisma.whatsAppBroadcastRecipient.findFirst({
      where: { broadcastId: id, status: "pending" },
      orderBy: { order: "asc" },
    });
    if (!next) {
      await prisma.whatsAppBroadcast.updateMany({
        where: { id, status: "sending" },
        data: { status: "done", finishedAt: new Date() },
      });
      return;
    }
    const { count } = await prisma.whatsAppBroadcastRecipient.updateMany({
      where: { id: next.id, status: "pending" },
      data: { status: "sending" },
    });
    if (count === 0) continue;

    try {
      const { waMessageId } = await sendWhatsAppTemplate({
        to: next.to,
        template: broadcast.template,
        languageCode: broadcast.language,
        body: next.values,
        category: broadcast.category,
        usage: { endpoint: "whatsapp:broadcast", userId: broadcast.createdById },
      });
      failuresInARow = 0;
      await prisma.whatsAppBroadcastRecipient.update({
        where: { id: next.id },
        data: { status: "accepted", waMessageId, sentAt: new Date() },
      });
      await prisma.whatsAppBroadcast.update({
        where: { id },
        data: { accepted: { increment: 1 } },
      });
    } catch (error) {
      failuresInARow++;
      const code = error instanceof WhatsAppSendError ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      await prisma.whatsAppBroadcastRecipient.update({
        where: { id: next.id },
        data: { status: "failed", errorCode: code ?? null, errorMessage: message.slice(0, 500) },
      });
      await prisma.whatsAppBroadcast.update({ where: { id }, data: { failed: { increment: 1 } } });

      // Nothing after this would get through either.
      if (error instanceof WhatsAppUnavailableError || code === 190) return pause(id, message);
      if (failuresInARow >= PAUSE_AFTER_FAILURES) {
        return pause(id, `${PAUSE_AFTER_FAILURES} messages in a row failed. The last: ${message}`);
      }
    }
    await sleep(PACE_MS);
  }
}

/**
 * At start-up: carries on every broadcast that was sending when the server
 * stopped. A recipient caught mid-send may or may not have got the message;
 * it is marked failed rather than sent again, because a second copy of an
 * announcement is worse than an admin seeing "may have arrived".
 */
export async function resumeBroadcasts() {
  const sending = await prisma.whatsAppBroadcast.findMany({
    where: { status: "sending" },
    select: { id: true },
  });
  for (const { id } of sending) {
    const { count } = await prisma.whatsAppBroadcastRecipient.updateMany({
      where: { broadcastId: id, status: "sending" },
      data: {
        status: "failed",
        errorMessage: "The server restarted while sending this one. It may have arrived.",
      },
    });
    if (count)
      await prisma.whatsAppBroadcast.update({
        where: { id },
        data: { failed: { increment: count } },
      });
    startBroadcast(id);
  }
  if (sending.length) console.log(`[Broadcast] Resumed ${sending.length} send(s).`);
}
