import express from "express";

import { whatsappWebhookController } from "../controllers/whatsappWebhookController";

export const webhookRouter = express.Router();

const { verify, receive } = whatsappWebhookController;

/**
 * @openapi
 * tags:
 *   name: Webhooks
 *   description: Called by third parties, not by the app. Public, and authenticated by signature
 */

/**
 * @openapi
 * /webhooks/whatsapp:
 *   get:
 *     summary: Meta's webhook handshake
 *     description: >
 *       Called once by Meta when the callback URL is saved. Echoes
 *       `hub.challenge` when `hub.mode` is "subscribe" and `hub.verify_token`
 *       equals WA_WEBHOOK_VERIFY_TOKEN.
 *     tags: [Webhooks]
 *     parameters:
 *       - { in: query, name: hub.mode, schema: { type: string } }
 *       - { in: query, name: hub.verify_token, schema: { type: string } }
 *       - { in: query, name: hub.challenge, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The challenge, as plain text
 *       403:
 *         description: Wrong or missing verify token
 *   post:
 *     summary: WhatsApp events from Meta
 *     description: >
 *       Delivery statuses for messages we sent, and messages devotees send to
 *       our number. Must carry `X-Hub-Signature-256`, the HMAC-SHA256 of the
 *       raw body under WA_APP_SECRET. Answered before the events are stored;
 *       replays are harmless.
 *     tags: [Webhooks]
 *     responses:
 *       200:
 *         description: Received
 *       400:
 *         description: Signed, but not JSON
 *       401:
 *         description: Missing or wrong signature
 *       503:
 *         description: WA_APP_SECRET is not set on the server
 */
webhookRouter.get("/whatsapp", verify);
webhookRouter.post("/whatsapp", receive);
