import express from "express";

import { inviteController } from "../controllers/inviteController";
import { protect } from "../middlewares/authMiddleware";

export const inviteRouter = express.Router();

const { getInvite, acceptInvite } = inviteController;

/**
 * @openapi
 * tags:
 *   name: Invites
 *   description: The invitee's side of an admin invite
 */

/**
 * @openapi
 * /invites/{token}:
 *   get:
 *     summary: What an invite link is for
 *     description: >
 *       Public, so the landing page can explain the invite before the visitor
 *       signs in. `status` is pending, accepted, revoked or expired.
 *     tags: [Invites]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The invite
 *       404:
 *         description: INVITE_NOT_FOUND
 */
inviteRouter.get("/:token", getInvite);

/**
 * @openapi
 * /invites/{token}/accept:
 *   post:
 *     summary: Accept an invite as the signed-in account
 *     description: >
 *       Grants the invite's role. An email invite only accepts the account
 *       with that email.
 *     tags: [Invites]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Accepted; the account now has `role`
 *       401:
 *         description: Not signed in
 *       403:
 *         description: EMAIL_MISMATCH — signed in with a different email
 *       410:
 *         description: INVITE_ACCEPTED, INVITE_REVOKED or INVITE_EXPIRED
 */
inviteRouter.post("/:token/accept", protect, acceptInvite);
