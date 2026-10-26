import { Resend } from "resend";

/**
 * Built lazily, not at import time: `dotenvFlow.config()` runs in `index.ts`'s
 * body, after the whole import graph is evaluated (§15 of the code context),
 * so a module-scope `new Resend(process.env.RESEND_API_KEY)` would freeze in
 * the pre-override environment.
 */
let client: Resend | null | undefined;

function getClient(): Resend | null {
  if (client === undefined) {
    const key = process.env.RESEND_API_KEY;
    client = key ? new Resend(key) : null;
  }
  return client;
}

/**
 * Whether a real key is set. `replace-me` is .env.example's placeholder: Resend
 * would accept the client and then fail every send with "API key is invalid".
 */
export function isEmailConfigured(): boolean {
  const key = process.env.RESEND_API_KEY;
  return !!key && key !== "replace-me";
}

export class EmailUnavailableError extends Error {
  constructor() {
    super("RESEND_API_KEY is not configured");
    this.name = "EmailUnavailableError";
  }
}

/**
 * Sends one transactional email through Resend.
 *
 * Throws `EmailUnavailableError` if no API key is configured, and the
 * Resend API's own error otherwise — callers decide what that means for the
 * request in front of them rather than this module swallowing it.
 */
export async function sendEmail(options: { to: string; subject: string; html: string }): Promise<void> {
  const resend = getClient();
  if (!resend) throw new EmailUnavailableError();

  /* The display name the inbox shows beside the subject — the most-read piece of
     branding in the whole email. */
  const from = process.env.RESEND_FROM_EMAIL || "Acme <onboarding@resend.dev>";
  const { error } = await resend.emails.send({
    from,
    to: options.to,
    subject: options.subject,
    html: options.html,
  });
  if (error) throw new Error(error.message);
}
