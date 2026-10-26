import crypto from "crypto";
import { Request, Response } from "express";

import { processWebhook, verifySignature } from "../lib/whatsapp-webhook";

/**
 * The URL Meta calls with WhatsApp events. Public, but only Meta can use it:
 *
 *   GET  /webhooks/whatsapp   the one-time handshake when the URL is saved in
 *                             Meta's dashboard — echo `hub.challenge` if the
 *                             verify token matches WA_WEBHOOK_VERIFY_TOKEN
 *   POST /webhooks/whatsapp   events, signed with WA_APP_SECRET; the body
 *                             arrives raw (src/index.ts) so the signature can
 *                             be checked against the exact bytes
 *
 * What the events mean is src/lib/whatsapp-webhook.ts.
 */

/** Constant-time string comparison for the verify token. */
function sameText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const verify = (req: Request, res: Response): void => {
  const expected = process.env.WA_WEBHOOK_VERIFY_TOKEN ?? "";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (
    expected &&
    mode === "subscribe" &&
    typeof token === "string" &&
    sameText(token, expected) &&
    typeof challenge === "string"
  ) {
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  console.warn("[WhatsApp] Webhook verification refused: wrong or missing verify token.");
  res.sendStatus(403);
};

const receive = (req: Request, res: Response): void => {
  const secret = process.env.WA_APP_SECRET ?? "";
  if (!secret) {
    // Without the secret nothing can be trusted, so nothing is stored. 503
    // rather than 200 so Meta retries once the server is configured.
    console.error("[WhatsApp] Webhook received but WA_APP_SECRET is not set — ignored.");
    res.sendStatus(503);
    return;
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifySignature(raw, req.header("x-hub-signature-256"), secret)) {
    console.warn("[WhatsApp] Webhook with a bad signature — refused.");
    res.sendStatus(401);
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    res.sendStatus(400);
    return;
  }

  // Answer first: Meta retries a slow response and eventually switches the
  // subscription off. Storing is idempotent, so a retry would be harmless —
  // but a dead subscription is not.
  res.sendStatus(200);
  processWebhook(body).catch(error =>
    console.error("[WhatsApp] Webhook processing failed:", error)
  );
};

export const whatsappWebhookController = { verify, receive };
