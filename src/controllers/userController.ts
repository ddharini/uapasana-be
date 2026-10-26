import { Request, Response } from "express";

import { prisma } from "../utils/db";

/**
 * The signed-in user's own record. Everything here runs behind `protect`, so
 * `req.user` is the authenticated user and the client never names which user it
 * is acting for.
 */

/**
 * Finishes onboarding.
 *
 * Onboarding here is a single step: there is nothing to collect, only a flag
 * to set. What matters is the call itself — it is what sets `onboardedAt`, and
 * the frontend guard keeps sending the user back to /onboarding until it has
 * been made.
 *
 * **Idempotent.** Re-stamping would move the date each time and quietly turn
 * "when did they onboard" into "when were they last here", so a repeat call
 * leaves the original timestamp alone.
 */
const completeOnboarding = async (req: Request, res: Response): Promise<void> => {
  try {
    const existing = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { onboardedAt: true },
    });

    if (!existing) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    // Already finished: answer before the gate below, never after.
    if (existing.onboardedAt) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, name: true, email: true, onboardedAt: true },
      });
      res.status(200).json({ success: true, data: { user } });
      return;
    }

    // If your product has a hard prerequisite for onboarding — a connected
    // integration, a required profile field, a chosen workspace — gate it here,
    // *before* the stamp below, and answer 409 with a `code` the frontend can
    // branch on. Nothing is required out of the box.

    const user = await prisma.user.update({
      where: { id: req.user.id },
      // Write-once. See the note above.
      data: existing.onboardedAt ? {} : { onboardedAt: new Date() },
      select: {
        id: true,
        name: true,
        email: true,
        onboardedAt: true,
      },
    });

    // Any one-off setup work belongs here, after the stamp — so a user who
    // abandons onboarding leaves no jobs behind. Enqueue it rather than doing it
    // inline, and swallow the failure: finishing onboarding must not depend on
    // the queue being healthy.

    res.status(200).json({ success: true, data: { user } });
  } catch (error) {
    console.error("Complete Onboarding Error:", error);
    res.status(500).json({ success: false, message: "Could not complete onboarding" });
  }
};

const auditLog = (userId: string, email: string, action: string, detail?: string) =>
  prisma.accountAuditLog.create({ data: { userId, email, action, detail } });

/**
 * Soft-deletes the signed-in account: `deletedAt` is stamped, every session is
 * revoked, and nothing else moves. The 30-day grace period and the eventual
 * real delete live in `scripts/hard-delete-scheduled-accounts.ts`.
 *
 * Verification is typing the account's own email address, not a password.
 * This used to require the password (or, for an OAuth-only account with none,
 * a fresh session) — dropped because most people asking to delete an account
 * they are about to walk away from do not remember a password for it, and a
 * blocked password is friction with nothing behind it any more: the action it
 * used to gate was irreversible, and now it is a 30-day-reversible schedule.
 * `protect` already requires a valid session; typing the email back is the
 * "yes, I mean it" step, the same job it already did for an OAuth-only
 * account before this, just no longer only for that one case.
 */
const deleteAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user.id as string;
    const email = req.user.email as string;

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    });
    if (!existing) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    if (existing.deletedAt) {
      res.status(200).json({ success: true, data: { deletedAt: existing.deletedAt } });
      return;
    }

    const typed = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!typed || typed !== email.toLowerCase()) {
      res.status(401).json({
        success: false,
        code: "EMAIL_MISMATCH",
        message: "Type your email address exactly as shown to confirm.",
      });
      return;
    }

    // Sequential rather than `$transaction` — Mongo transactions need a
    // replica set this deployment does not guarantee, and nothing here reads
    // its own write, so there is nothing a transaction would protect.
    const deletedAt = new Date();
    await prisma.user.update({ where: { id: userId }, data: { deletedAt } });
    // Every session, including the one this request is authenticated with —
    // deletion signs the account out everywhere, immediately.
    await prisma.session.deleteMany({ where: { userId } });
    await auditLog(userId, email, "delete_requested", "verified by typed email confirmation");

    res.status(200).json({ success: true, data: { deletedAt } });
  } catch (error) {
    console.error("Delete Account Error:", error);
    res.status(500).json({ success: false, message: "Could not delete your account" });
  }
};

/**
 * Clears `deletedAt` within the grace period. Reachable at all only because
 * signing back in still works — Better Auth's `signIn` has no idea what
 * `deletedAt` means, so a soft-deleted account signs in exactly as it always
 * did, and this is the first authenticated thing it is allowed to do.
 */
const restoreAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user.id as string;
    const email = req.user.email as string;

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    });
    if (!existing?.deletedAt) {
      res.status(409).json({
        success: false,
        code: "NOT_DELETED",
        message: "This account is not scheduled for deletion.",
      });
      return;
    }

    await prisma.user.update({ where: { id: userId }, data: { deletedAt: null } });
    await auditLog(userId, email, "delete_restored");

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Restore Account Error:", error);
    res.status(500).json({ success: false, message: "Could not restore your account" });
  }
};

export const userController = {
  completeOnboarding,
  deleteAccount,
  restoreAccount,
};
