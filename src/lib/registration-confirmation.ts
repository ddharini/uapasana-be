import type { Registration } from "@prisma/client";

import {
  WHATSAPP_TEMPLATES,
  WHATSAPP_LANGS,
  defaultWhatsAppLang,
  isWhatsAppConfigured,
  sendWhatsAppTemplate,
  type WhatsAppLang,
} from "./whatsapp";

/**
 * The WhatsApp message a devotee gets once their registration is saved: the
 * code to show at the desk, how many people it covers, and the stay it holds.
 *
 * Sent to the primary contact's number, which was just proved by an OTP (or
 * vouched for at the desk), so it reaches the person who registered. It goes
 * after the response, and a failed send is only logged: the registration is
 * saved either way and the screen already shows the same code, so a WhatsApp
 * outage must never turn a successful registration into an error.
 *
 * The template's wording lives on Meta (`registration_confirmation`, Utility,
 * en + gu); setup.md has it. Only the four values travel from here.
 */

/** The slot words in each language the template is approved in. */
const SLOT_WORDS: Record<WhatsAppLang, Record<string, string>> = {
  en: { morning: "morning", afternoon: "afternoon", evening: "evening" },
  gu: { morning: "સવાર", afternoon: "બપોર", evening: "સાંજ" },
};

/** "30 Jan, morning" / "30 જાન્યુ, સવાર" — a calendar day at the venue, no time zone. */
function formatStayPoint(point: { date: string; slot: string }, lang: WhatsAppLang) {
  const [y, m, d] = point.date.split("-").map(Number);
  const day = new Intl.DateTimeFormat(lang === "gu" ? "gu-IN" : "en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
  const slot = SLOT_WORDS[lang][point.slot];
  return slot ? `${day}, ${slot}` : day;
}

/**
 * The template's `{{1}}`…`{{4}}`, in order: the contact's first name, the
 * registration's code (a family's `DM-F-…`, an individual's own), how many
 * people it covers, and its stay from the first person in to the last out.
 */
export function confirmationValues(
  registration: Pick<Registration, "code" | "members" | "arrival" | "departure">,
  lang: WhatsAppLang
): string[] {
  const contact = registration.members.find(m => m.isPrimary) ?? registration.members[0];
  return [
    contact?.firstName?.trim() || contact?.fullName.split(" ")[0] || "",
    registration.code,
    String(registration.members.length),
    `${formatStayPoint(registration.arrival, lang)} – ${formatStayPoint(registration.departure, lang)}`,
  ];
}

/** The language the form was shown in, when the request says; the default otherwise. */
export function confirmationLang(value: unknown): WhatsAppLang {
  return WHATSAPP_LANGS.includes(value as WhatsAppLang)
    ? (value as WhatsAppLang)
    : defaultWhatsAppLang();
}

/**
 * Sends the confirmation and never throws. Dummy registrations and ones whose
 * contact has no mobile get nothing; neither does a server without WhatsApp,
 * which is every local setup that has not been given the `WA_*` settings.
 */
export async function sendRegistrationConfirmation(
  registration: Registration,
  lang: WhatsAppLang
): Promise<void> {
  const to = registration.contactMobile;
  if (!to || registration.isSample || !isWhatsAppConfigured()) return;
  try {
    await sendWhatsAppTemplate({
      to,
      template: WHATSAPP_TEMPLATES.registrationConfirmation(),
      lang,
      body: confirmationValues(registration, lang),
      usage: { endpoint: "whatsapp:registration_confirmation" },
    });
  } catch (error) {
    console.error(`[WhatsApp] Registration confirmation for ${registration.code} failed:`, error);
  }
}
