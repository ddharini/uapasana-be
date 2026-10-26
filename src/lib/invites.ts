import crypto from "crypto";
import { z } from "zod";
import type { AdminInvite } from "@prisma/client";

import { INVITE_ROLES, MANDALS, MOBILE_E164 } from "./event";

/**
 * Admin invites: the token, the link it goes into, what `POST /admin/invites`
 * accepts, and how an invite is sent back.
 */

/** How long a link stays usable. Long enough to survive a weekend, short enough that a stale WhatsApp forward dies. */
export const INVITE_TTL_DAYS = 7;

/** 32 random bytes, URL-safe. The plain token only ever exists in the link. */
export function newInviteToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * The page the invitee opens. Read at call time, not into a constant, for the
 * same reason as `appUrl` in email-templates.ts: env is loaded after imports.
 */
export function inviteUrl(token: string) {
  const base = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
  return `${base}/invite/${token}`;
}

/** Who the invite makes them: an admin, or a sanchalak for one mandal. */
const roleFields = {
  name: z.string().trim().max(120).optional(),
  role: z.enum(INVITE_ROLES).default("admin"),
  mandal: z.enum(MANDALS, { error: "Select the mandal they will coordinate" }).optional(),
};

export const createInviteSchema = z
  .discriminatedUnion("channel", [
    z.object({
      channel: z.literal("email"),
      email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
      ...roleFields,
    }),
    z.object({
      channel: z.literal("mobile"),
      mobile: z.string().trim().regex(MOBILE_E164, "Enter a valid mobile number with country code"),
      ...roleFields,
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.role === "sanchalak" && !value.mandal) {
      ctx.addIssue({ code: "custom", path: ["mandal"], message: "Select the mandal they will coordinate" });
    }
  });

export type CreateInviteInput = z.infer<typeof createInviteSchema>;

/** "pending" invites past `expiresAt` are reported as "expired". */
export function inviteState(invite: Pick<AdminInvite, "status" | "expiresAt">) {
  if (invite.status === "pending" && invite.expiresAt.getTime() <= Date.now()) return "expired";
  return invite.status as "pending" | "accepted" | "revoked";
}

/** What the admin screen shows. Never includes the token or its hash. */
export function toInviteDto(invite: AdminInvite) {
  return {
    id: invite.id,
    channel: invite.channel,
    email: invite.email,
    mobile: invite.mobile,
    name: invite.name,
    role: invite.role,
    mandal: invite.mandal,
    status: inviteState(invite),
    invitedByName: invite.invitedByName,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  };
}
