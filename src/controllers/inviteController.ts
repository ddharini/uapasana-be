import { Request, Response } from "express";

import { hashInviteToken, inviteState } from "../lib/invites";
import { prisma } from "../utils/db";

/**
 * The invitee's side of an admin invite: what the link says, and accepting it.
 * The admin's side (sending, listing, revoking) is adminInvitesController.ts.
 */

const findByToken = (token: string) =>
  prisma.adminInvite.findUnique({ where: { tokenHash: hashInviteToken(token) } });

const notFound = (res: Response) =>
  res.status(404).json({ success: false, code: "INVITE_NOT_FOUND", message: "This invite link is not valid." });

/**
 * Public: the landing page reads this before the visitor signs in, to say who
 * invited them and — for an email invite — which address to sign in with.
 * Holding the token is the proof of being the recipient, so showing the
 * address it was sent to reveals nothing new.
 */
const getInvite = async (req: Request, res: Response): Promise<void> => {
  const invite = await findByToken(String(req.params.token));
  if (!invite) return void notFound(res);

  res.status(200).json({
    success: true,
    data: {
      status: inviteState(invite),
      channel: invite.channel,
      email: invite.email,
      name: invite.name,
      role: invite.role,
      mandal: invite.mandal,
      invitedByName: invite.invitedByName,
      expiresAt: invite.expiresAt,
    },
  });
};

/**
 * Signed in: grants the invite's role to the signed-in account.
 *
 * The pending → accepted flip is a conditional update, so two tabs (or two
 * people holding a forwarded mobile link) racing to accept cannot both win.
 */
const acceptInvite = async (req: Request, res: Response): Promise<void> => {
  const invite = await findByToken(String(req.params.token));
  if (!invite) return void notFound(res);

  const state = inviteState(invite);
  if (state !== "pending") {
    res.status(410).json({
      success: false,
      code: `INVITE_${state.toUpperCase()}`,
      message:
        state === "accepted"
          ? "This invite has already been used."
          : state === "revoked"
            ? "This invite was cancelled. Ask for a new one."
            : "This invite has expired. Ask for a new one.",
    });
    return;
  }

  if (invite.channel === "email" && invite.email !== String(req.user.email).toLowerCase()) {
    res.status(403).json({
      success: false,
      code: "EMAIL_MISMATCH",
      message: `This invite is for ${invite.email}. Sign in with that email to accept it.`,
    });
    return;
  }

  // Never a step down: an admin opening a sanchalak invite keeps admin.
  if (req.user.role === "admin" && invite.role !== "admin") {
    res.status(409).json({ success: false, code: "ALREADY_ADMIN", message: "You are already an admin, which includes everything a sanchalak can do." });
    return;
  }

  const { count } = await prisma.adminInvite.updateMany({
    where: { id: invite.id, status: "pending" },
    data: { status: "accepted", acceptedById: req.user.id, acceptedAt: new Date() },
  });
  if (count === 0) {
    res.status(410).json({ success: false, code: "INVITE_ACCEPTED", message: "This invite has already been used." });
    return;
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: { role: invite.role, mandal: invite.role === "sanchalak" ? invite.mandal : null },
  });

  res.status(200).json({ success: true, data: { role: invite.role, mandal: invite.mandal } });
};

export const inviteController = {
  getInvite,
  acceptInvite,
};
