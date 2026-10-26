import { recordUsage } from "./usage";
import { logSentMessage } from "./whatsapp-log";

/**
 * WhatsApp messages, sent through Meta's WhatsApp Cloud API directly (no BSP).
 *
 * The only file that talks to graph.facebook.com. MSG91 was the first plan
 * and was never configured; it was removed on 2026-10-19 when the trust's own
 * WhatsApp Business Account went live on Meta.
 *
 * WhatsApp only lets a business start a conversation with a **template** Meta
 * has approved, so every message here is a template name, a language, and the
 * values for its `{{1}}`, `{{2}}`… placeholders. Templates are created in
 * WhatsApp Manager → Message templates; setup.md lists the exact wording.
 * Templates belong to a WhatsApp Business Account: the test number's WABA and
 * the production one each need their own copy.
 *
 * Read from the environment at call time, never at import: env is loaded in
 * src/env.ts, and a module-scope read here would freeze whatever came first —
 * the same reason src/lib/email.ts builds its client lazily.
 */

const TIMEOUT_MS = 10_000;

/**
 * Meta's India rate per template message, by category, in rupees before 18%
 * GST. Approximate on purpose: it is for estimates and the usage ledger, and
 * the exact figure is on Meta's invoice. Served to the Send messages screen,
 * which shows what a send will cost before it starts.
 */
export const WHATSAPP_PRICE_INR: Record<string, number> = {
  AUTHENTICATION: 0.115,
  UTILITY: 0.115,
  MARKETING: 0.86,
};
/** Rupees to US dollars, for the usage ledger, which is kept in dollars. */
const INR_PER_USD = 84;
export const priceUsd = (category = "UTILITY") =>
  (WHATSAPP_PRICE_INR[category] ?? WHATSAPP_PRICE_INR.UTILITY) / INR_PER_USD;

/**
 * Waits between attempts when Meta says "not now". Short, because the OTP
 * send runs inside the devotee's request and they are watching a spinner.
 */
const RETRY_DELAYS_MS = [500, 1500];

/**
 * Meta error codes worth another try: throttling (4, 80007, 130429) and its
 * own transient failures (1, 2, 131000, 133004). Deliberately not 131056 (too
 * many messages to one number) — that pair limit lasts longer than a request.
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 133004]);
/** "Template name does not exist in the translation": no copy in that language. */
const MISSING_TRANSLATION = 132001;
/** The access token expired or was revoked — the temporary one lasts ~24 hours. */
const TOKEN_INVALID = 190;

/** The languages the public pages are shown in, and so the ones templates are approved in. */
export const WHATSAPP_LANGS = ["en", "gu"] as const;
export type WhatsAppLang = (typeof WHATSAPP_LANGS)[number];

/** Approved template names, each overridable from .env in case Meta made us pick another. */
export const WHATSAPP_TEMPLATES = {
  /** {{1}} inviter, {{2}} event, {{3}} role ("an admin", "Mandal sanchalak for Surat"); button: the token. */
  teamInvite: () => process.env.WA_TEMPLATE_INVITE || "team_invite",
  /** An Authentication-category template: the code in the body and on its copy-code button. */
  otp: () => process.env.WA_TEMPLATE_OTP || "anoopam_otp",
  /** {{1}} contact's first name, {{2}} registration code, {{3}} people, {{4}} stay. Utility, en + gu. */
  registrationConfirmation: () =>
    process.env.WA_TEMPLATE_REGISTRATION || "registration_confirmation",
  /** {{1}} contact's name, {{2}} event, {{3}} where everyone stays, on one line. Paused feature. */
  stayDetails: () => process.env.WA_TEMPLATE_ROOM_DETAILS || "room_details",
};

export class WhatsAppUnavailableError extends Error {
  constructor() {
    super("WhatsApp is not configured: set WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID");
    this.name = "WhatsAppUnavailableError";
  }
}

/** Meta refused the message, or could not be reached. Carries Meta's own code when it gave one. */
export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

const isSet = (value: string | undefined): value is string =>
  !!value && value.trim() !== "" && value !== "replace-me";

/** Whether the server can send WhatsApp messages at all. */
export function isWhatsAppConfigured(): boolean {
  return isSet(process.env.WA_ACCESS_TOKEN) && isSet(process.env.WA_PHONE_NUMBER_ID);
}

/** The language a message goes out in when the caller does not know the reader's. */
export function defaultWhatsAppLang(): WhatsAppLang {
  const lang = process.env.WA_DEFAULT_LANG as WhatsAppLang;
  return WHATSAPP_LANGS.includes(lang) ? lang : "en";
}

/**
 * The language code a template was approved under. Meta tells "English" (`en`)
 * and "English (US)" (`en_US`) apart, and a send under the wrong one fails with
 * 132001 — so the code is configurable rather than assumed.
 */
export function templateLanguageCode(lang: WhatsAppLang): string {
  return (lang === "gu" ? process.env.WA_LANG_CODE_GU : process.env.WA_LANG_CODE_EN) || lang;
}

/**
 * What the Cloud API wants in `to`: country code and number, digits only, no
 * `+`. A bare 10-digit number is Indian (`91` added); a trunk `0` before one
 * and an international `00` prefix are dropped. Stored numbers are already
 * E.164, so in practice this only strips the `+`.
 */
export function toWhatsAppNumber(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length < 11 || digits.length > 15) {
    throw new WhatsAppSendError(`Not a phone number WhatsApp can send to: "${phone}"`, 400);
  }
  return digits;
}

/** The Cloud API's `components` for a template: body values in order, then one URL-button value. */
export function templateComponents(body: string[] = [], buttonUrl?: string) {
  const components: object[] = [];
  if (body.length > 0) {
    components.push({ type: "body", parameters: body.map(text => ({ type: "text", text })) });
  }
  // Both a "Visit website" button's dynamic suffix and an Authentication
  // template's copy-code button are sent this way: Meta models copy-code as a
  // URL button whose value is the code.
  if (buttonUrl !== undefined) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: buttonUrl }],
    });
  }
  return components;
}

type GraphError = { message?: string; code?: number; error_data?: { details?: string } };

/** Turns one failed response into an error that says what Meta said, and whether to try again. */
function toSendError(status: number, error: GraphError | undefined): WhatsAppSendError {
  const code = error?.code;
  const detail = error?.error_data?.details ?? error?.message ?? `HTTP ${status}`;
  const message =
    code === TOKEN_INVALID
      ? `WA_ACCESS_TOKEN is expired or invalid — generate a new one (${detail})`
      : `Meta refused the WhatsApp message${code ? ` (${code})` : ""}: ${detail}`;
  const retryable = status >= 500 || (code !== undefined && RETRYABLE_CODES.has(code));
  return new WhatsAppSendError(message, status, code, retryable);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One POST to the messages endpoint. Resolves to the message id Meta assigned. */
async function postOnce(payload: object): Promise<string> {
  const version = process.env.WA_GRAPH_VERSION || "v25.0";
  const url = `https://graph.facebook.com/${version}/${process.env.WA_PHONE_NUMBER_ID}/messages`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or a dropped connection. Retrying can deliver twice if Meta
    // did accept it; for a code or an invite a duplicate beats nothing.
    throw new WhatsAppSendError(
      `Could not reach Meta: ${(error as Error).message}`,
      0,
      undefined,
      true
    );
  }

  // A non-JSON body (a gateway error page) is a failure too.
  const result = (await response.json().catch(() => null)) as {
    messages?: { id?: string }[];
    error?: GraphError;
  } | null;
  const id = result?.messages?.[0]?.id;
  if (!response.ok || !id) throw toSendError(response.status, result?.error);
  return id;
}

/**
 * Sends one approved template to one number, and returns Meta's message id
 * (`wamid.…`) — the key the delivery webhook reports statuses under.
 *
 * Throttling and Meta's transient failures are retried with backoff. A
 * template with no copy in the reader's language is sent once more in the
 * default one, so a Gujarati translation still waiting for approval does not
 * stop the code from arriving.
 *
 * Throws `WhatsAppUnavailableError` when the Cloud API is not configured, and
 * `WhatsAppSendError` carrying Meta's code and message when the send is
 * refused — callers decide what a failed message means for their request.
 */
export async function sendWhatsAppTemplate(options: {
  /** Any common form; see `toWhatsAppNumber`. Stored numbers are E.164, e.g. "+919876543210". */
  to: string;
  template: string;
  /** The reader's language. Defaults to WA_DEFAULT_LANG. */
  lang?: WhatsAppLang;
  /** A raw template language code, for templates outside the app's own (e.g. `hello_world`, `en_US`). */
  languageCode?: string;
  /** Values for the body's {{1}}, {{2}}…, in order. */
  body?: string[];
  /** Value for a "Visit website" button's dynamic URL suffix, or an Authentication template's code. */
  buttonUrl?: string;
  /** Usage-ledger attribution. */
  usage: { endpoint: string; userId?: string };
  /** Meta's category of the template, for the price in the ledger. Utility when left out. */
  category?: string;
}): Promise<{ waMessageId: string }> {
  if (!isWhatsAppConfigured()) throw new WhatsAppUnavailableError();

  const fallbackLang = defaultWhatsAppLang();
  const lang = options.lang ?? fallbackLang;
  const to = toWhatsAppNumber(options.to);
  const payloadFor = (languageCode: string) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: options.template,
      language: { code: languageCode },
      components: templateComponents(options.body, options.buttonUrl),
    },
  });

  let languageCode = options.languageCode ?? templateLanguageCode(lang);
  let waMessageId: string | undefined;
  for (let attempt = 0; waMessageId === undefined; attempt++) {
    try {
      waMessageId = await postOnce(payloadFor(languageCode));
    } catch (error) {
      if (!(error instanceof WhatsAppSendError)) throw error;
      const otherLanguage = templateLanguageCode(fallbackLang);
      if (
        error.code === MISSING_TRANSLATION &&
        !options.languageCode &&
        languageCode !== otherLanguage
      ) {
        console.warn(
          `[WhatsApp] "${options.template}" has no ${languageCode} copy; sending ${otherLanguage}.`
        );
        languageCode = otherLanguage;
        continue;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (!error.retryable || delay === undefined) throw error;
      console.warn(`[WhatsApp] ${error.message} — retrying in ${delay} ms`);
      await sleep(delay);
    }
  }

  await Promise.all([
    recordUsage({ ...options.usage, costUsd: priceUsd(options.category) }),
    logSentMessage({
      waMessageId,
      to,
      template: options.template,
      language: languageCode,
      purpose: options.usage.endpoint,
    }),
  ]);
  return { waMessageId };
}

/** A message template as Meta lists it, as much of it as we read. */
export type MetaTemplate = {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  parameter_format?: string;
  components: {
    type: string;
    format?: string;
    text?: string;
    buttons?: { type: string; text?: string; url?: string }[];
  }[];
};

/**
 * Every message template on our WhatsApp Business Account (WA_WABA_ID), one
 * entry per language, whatever its status. Throws `WhatsAppUnavailableError`
 * without the account id or token, and `WhatsAppSendError` when Meta refuses.
 */
export async function listMessageTemplates(): Promise<MetaTemplate[]> {
  const waba = process.env.WA_WABA_ID;
  if (!isWhatsAppConfigured() || !isSet(waba)) throw new WhatsAppUnavailableError();
  const version = process.env.WA_GRAPH_VERSION || "v25.0";
  const templates: MetaTemplate[] = [];
  let url: string | undefined =
    `https://graph.facebook.com/${version}/${waba}/message_templates?` +
    new URLSearchParams({
      fields: "id,name,status,category,language,parameter_format,components",
      limit: "100",
    });
  // Paged; a handful of pages at most for any account this app will have.
  for (let page = 0; url && page < 10; page++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new WhatsAppSendError(
        `Could not reach Meta: ${(error as Error).message}`,
        0,
        undefined,
        true
      );
    }
    const result = (await response.json().catch(() => null)) as {
      data?: MetaTemplate[];
      paging?: { next?: string };
      error?: GraphError;
    } | null;
    if (!response.ok || !result?.data) throw toSendError(response.status, result?.error);
    templates.push(...result.data);
    url = result.paging?.next;
  }
  return templates;
}
