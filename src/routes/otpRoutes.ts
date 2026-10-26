import express from "express";

import { otpController } from "../controllers/otpController";

export const otpRouter = express.Router();

const { send, verify } = otpController;

/**
 * @openapi
 * tags:
 *   name: OTP
 *   description: Mobile number verification for the registration form (public)
 */

/**
 * @openapi
 * /otp/send:
 *   post:
 *     summary: Send a 6-digit code to a mobile number on WhatsApp
 *     description: >
 *       The code works for 10 minutes and for 5 guesses. At most one code per
 *       number every 30 seconds and 5 per hour, plus an overall hourly cap
 *       (OTP_MAX_PER_HOUR). Without WhatsApp configured, development returns the
 *       code as `devCode` and production answers 503 OTP_UNAVAILABLE.
 *     tags: [OTP]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mobile: { type: string, description: "E.164, e.g. +919876543210" }
 *               lang: { type: string, enum: [en, gu], description: "The template language; defaults to WA_DEFAULT_LANG" }
 *     responses:
 *       200:
 *         description: "`{ expiresInSeconds, resendAfterSeconds, devCode? }`"
 *       429:
 *         description: OTP_COOLDOWN (with retryAfterSeconds), OTP_LIMIT or OTP_BUSY
 *       502:
 *         description: OTP_SEND_FAILED — Meta refused it or could not be reached
 *       503:
 *         description: OTP_UNAVAILABLE — WhatsApp not configured (production)
 */
otpRouter.post("/send", send);

/**
 * @openapi
 * /otp/verify:
 *   post:
 *     summary: Check a code; on success returns a token for the registration
 *     description: >
 *       The token proves the number was verified. Send it as
 *       `mobileVerificationToken` with POST /registrations within 2 hours.
 *       It works once.
 *     tags: [OTP]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mobile: { type: string }
 *               code: { type: string }
 *     responses:
 *       200:
 *         description: "`{ verificationToken }`"
 *       400:
 *         description: OTP_WRONG or OTP_EXPIRED
 *       429:
 *         description: OTP_TOO_MANY_ATTEMPTS
 */
otpRouter.post("/verify", verify);
