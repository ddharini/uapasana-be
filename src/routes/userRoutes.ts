import express from "express";
import { userController } from "../controllers/userController";
import { protect } from "../middlewares/authMiddleware";

export const userRouter = express.Router();

const { completeOnboarding, deleteAccount, restoreAccount } = userController;

/**
 * @openapi
 * tags:
 *   name: Users
 *   description: The signed-in user's own record
 */

// Separate from /auth, which is a straight passthrough to Better Auth's handler
// and owns no routes of its own. These are ours.
userRouter.use(protect);

/**
 * @openapi
 * /users/onboarding:
 *   post:
 *     summary: Finish onboarding
 *     description: >
 *       Sets `onboardedAt`, which is what releases the frontend's onboarding
 *       guard. The call itself is what completes onboarding — there is
 *       nothing else to submit.
 *
 *       Idempotent: a repeat call leaves the original timestamp alone.
 *
 *       Declared to Better Auth with `input: false`, so this endpoint is the
 *       only way to write it.
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: Onboarding complete; the updated user is returned
 *       401:
 *         description: Not signed in
 */
userRouter.post("/onboarding", completeOnboarding);

/**
 * @openapi
 * /users/delete:
 *   post:
 *     summary: Schedule the signed-in account for deletion
 *     description: >
 *       A soft delete: sets `deletedAt` and revokes every session. Nothing
 *       else is touched. The account
 *       is purged for real 30 days later, by
 *       `scripts/hard-delete-scheduled-accounts.ts`, unless `/users/restore`
 *       is called first.
 *
 *       Verified by typing the account's own
 *       email address back, not a password: `protect` already requires a
 *       valid session, and a 30-day-reversible action does not need a
 *       forgotten password standing in its way.
 *     tags: [Users]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 description: Must match the signed-in account's own email address.
 *     responses:
 *       200:
 *         description: Scheduled for deletion (or already was)
 *       401:
 *         description: EMAIL_MISMATCH
 */
userRouter.post("/delete", deleteAccount);

/**
 * @openapi
 * /users/restore:
 *   post:
 *     summary: Cancel a pending deletion, within the 30-day grace period
 *     description: >
 *       Clears `deletedAt`. Reachable because signing back in still works on a
 *       soft-deleted account — Better Auth's own sign-in has no idea what
 *       `deletedAt` means — so this is the one thing the frontend's restore
 *       screen lets that session do.
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: Restored
 *       409:
 *         description: NOT_DELETED — nothing to restore
 */
userRouter.post("/restore", restoreAccount);
