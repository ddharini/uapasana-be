/**
 * Sends one WhatsApp template through the Cloud API, to check the setup end to
 * end without going through the registration form.
 *
 *   pnpm wa:test <number>                 Meta's own hello_world (en_US)
 *   pnpm wa:test <number> otp [en|gu]     the OTP template, with a made-up code
 *
 * Uses whatever WA_* settings .env holds. Point WA_PHONE_NUMBER_ID at the TEST
 * number while trying things: it only delivers to the (up to five) recipients
 * added in App → WhatsApp → API Setup, and Meta does not bill it. Templates
 * belong to one WhatsApp Business Account, so `otp` works on the test number
 * only once the OTP template has been created in the test WABA as well.
 *
 * Every send from the production number is a paid message.
 */
import "../src/env";

import { WHATSAPP_TEMPLATES, sendWhatsAppTemplate, type WhatsAppLang } from "../src/lib/whatsapp";
import { newOtpCode } from "../src/lib/otp";
import { prisma } from "../src/utils/db";

async function main() {
  const [to, which = "hello", lang = "en"] = process.argv.slice(2);
  if (!to || !["hello", "otp"].includes(which) || !["en", "gu"].includes(lang)) {
    console.error("Usage: pnpm wa:test <number> [hello | otp [en|gu]]");
    process.exit(1);
  }

  console.log(
    `Sending "${which}" from phone number id ${process.env.WA_PHONE_NUMBER_ID} to ${to}…`
  );
  const usage = { endpoint: "whatsapp:test" };
  const { waMessageId } =
    which === "otp"
      ? await (async () => {
          const code = newOtpCode();
          console.log(`Code: ${code}`);
          return sendWhatsAppTemplate({
            to,
            template: WHATSAPP_TEMPLATES.otp(),
            lang: lang as WhatsAppLang,
            body: [code],
            buttonUrl: code,
            usage,
          });
        })()
      : await sendWhatsAppTemplate({ to, template: "hello_world", languageCode: "en_US", usage });

  console.log(`Accepted by Meta: ${waMessageId}`);
  console.log("Accepted is not delivered — check the phone. Delivery status needs the webhook.");
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
