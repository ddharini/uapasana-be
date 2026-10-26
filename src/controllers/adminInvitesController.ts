import { Request, Response } from "express";

import { isEmailConfigured, sendEmail } from "../lib/email";
import { adminInviteEmail } from "../lib/email-templates";
import { EVENT_NAME, roleDescription } from "../lib/event";
import {
  INVITE_TTL_DAYS,
  createInviteSchema,
  inviteUrl,
  newInviteToken,
  toInviteDto,
} from "../lib/invites";
import { WHATSAPP_TEMPLATES, isWhatsAppConfigured, sendWhatsAppTemplate } from "../lib/whatsapp";
import { prisma } from "../utils/db";

/**
 * The admin team: who is an admin, who has been invited, and sending and
 * revoking invites. Everything here runs behind `protect` + `requireAdmin`.
 *
 * The other side — opening the link and accepting it — is inviteController.ts.
 */

/** Same 400 shape as registrationController, so the frontend reads both the same way. */
function validationError(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  res.status(400).json({
    success: false,
    code: "VALIDATION_ERROR",
    message: issues[0]?.message ?? "Some details are missing or invalid.",
    errors: issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

/**
 * Current admins, oldest first, every invite still waiting to be accepted, and
 * which channels the server can deliver on — so the screen can say "we send
 * it" or "you send it" before the admin picks one.
 */
const listTeam = async (_req: Request, res: Response): Promise<void> => {
  const [admins, invites] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ["admin", "sanchalak"] } },
      select: { id: true, name: true, email: true, image: true, role: true, mandal: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.adminInvite.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      admins,
      invites: invites.map(toInviteDto),
      delivery: { email: isEmailConfigured(), whatsapp: isWhatsAppConfigured() },
    },
  });
};

/**
 * Creates an invite and sends it: by email through Resend, or on WhatsApp
 * through Meta's Cloud API.
 *
 * The link is returned to the admin either way. A send that fails — the
 * provider is down, not configured yet, or refuses the number — should not
 * cost the admin the invite they just made; they can still share the link
 * themselves. `sent` says whether the server delivered it, and `notSentReason`
 * why not.
 */
const createInvite = async (req: Request, res: Response): Promise<void> => {
  const parsed = createInviteSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const input = parsed.data;

  if (input.channel === "email") {
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { role: true, mandal: true },
    });
    // An admin is never invited down to sanchalak, and nobody is invited to
    // what they already are.
    if (existing?.role === "admin") {
      res.status(409).json({ success: false, code: "ALREADY_ADMIN", message: `${input.email} is already an admin.` });
      return;
    }
    if (existing?.role === "sanchalak" && input.role === "sanchalak" && existing.mandal === input.mandal) {
      res.status(409).json({
        success: false,
        code: "ALREADY_MEMBER",
        message: `${input.email} is already the sanchalak for ${input.mandal}.`,
      });
      return;
    }
  }
  const mandal = input.role === "sanchalak" ? input.mandal! : null;
  const roleText = roleDescription(input.role, mandal);

  // Only the newest link for an address works. Re-inviting is how an admin
  // recovers from a lost message, and the old link should die with it.
  const target = input.channel === "email" ? { email: input.email } : { mobile: input.mobile };
  await prisma.adminInvite.updateMany({
    where: { ...target, status: "pending" },
    data: { status: "revoked" },
  });

  const { token, tokenHash } = newInviteToken();
  const invite = await prisma.adminInvite.create({
    data: {
      tokenHash,
      channel: input.channel,
      email: input.channel === "email" ? input.email : null,
      mobile: input.channel === "mobile" ? input.mobile : null,
      name: input.name || null,
      role: input.role,
      mandal,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      invitedById: req.user.id,
      invitedByName: req.user.name,
    },
  });

  const url = inviteUrl(token);
  let notSentReason: "not_configured" | "failed" | undefined;

  if (input.channel === "email") {
    if (!isEmailConfigured()) {
      notSentReason = "not_configured";
    } else {
      try {
        const { subject, html } = adminInviteEmail({
          inviterName: req.user.name,
          name: input.name,
          roleText,
          url,
          expiresAt: invite.expiresAt,
        });
        await sendEmail({ to: input.email, subject, html });
      } catch (error) {
        console.error(`[Email] Admin invite to ${input.email} failed:`, error);
        notSentReason = "failed";
      }
    }
  } else {
    if (!isWhatsAppConfigured()) {
      notSentReason = "not_configured";
    } else {
      try {
        // The template's button URL is fixed as <site>/invite/{{1}} when it is
        // created in WhatsApp Manager, so only the token travels here.
        await sendWhatsAppTemplate({
          to: input.mobile,
          template: WHATSAPP_TEMPLATES.teamInvite(),
          body: [req.user.name, EVENT_NAME, roleText],
          buttonUrl: token,
          usage: { endpoint: "whatsapp:admin_invite", userId: req.user.id },
        });
      } catch (error) {
        console.error(`[WhatsApp] Admin invite to ${input.mobile} failed:`, error);
        notSentReason = "failed";
      }
    }
  }

  res.status(201).json({
    success: true,
    data: { invite: toInviteDto(invite), url, sent: !notSentReason, notSentReason },
  });
};

/** Kills a pending link. Accepted invites are history and stay as they are. */
const revokeInvite = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{24}$/.test(id)) {
    res.status(404).json({ success: false, code: "NOT_FOUND", message: "No such invite" });
    return;
  }

  const { count } = await prisma.adminInvite.updateMany({
    where: { id, status: "pending" },
    data: { status: "revoked" },
  });
  if (count === 0) {
    res.status(404).json({ success: false, code: "NOT_FOUND", message: "No pending invite with that id" });
    return;
  }

  res.status(200).json({ success: true, data: { id } });
};

export const adminInvitesController = {
  listTeam,
  createInvite,
  revokeInvite,
};
