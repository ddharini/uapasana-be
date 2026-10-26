import { Request, Response } from "express";
import type { Prisma } from "@prisma/client";

import { prisma } from "../utils/db";

/**
 * Admin views over `User` — a list grid with search/role/status filters, and a
 * per-user detail (profile, and auth/account activity history).
 *
 * Entirely read-only: there is no admin action here that writes to somebody
 * else's account.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type ActivityCategory = "auth" | "account";

interface ActivityEntry {
  id: string;
  category: ActivityCategory;
  title: string;
  description: string | null;
  at: Date;
}

const titleCase = (value: string): string =>
  value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Auth and account-lifecycle history for one user, merged into a single
 * timeline. `Session` rows double as sign-in events since Better Auth creates
 * one per login and this codebase has no separate auth log.
 */
const buildActivity = (
  sessions: { id: string; createdAt: Date; ipAddress: string | null; userAgent: string | null }[],
  accounts: { id: string; providerId: string; createdAt: Date }[],
  auditLog: { id: string; action: string; detail: string | null; createdAt: Date }[]
): ActivityEntry[] => {
  const auth: ActivityEntry[] = [
    ...sessions.map((s) => ({
      id: `session:${s.id}`,
      category: "auth" as const,
      title: "Signed in",
      description: [s.ipAddress, s.userAgent].filter(Boolean).join(" · ") || null,
      at: s.createdAt,
    })),
    ...accounts.map((a) => ({
      id: `account:${a.id}`,
      category: "auth" as const,
      title: a.providerId === "credential" ? "Created password login" : `Connected ${titleCase(a.providerId)} account`,
      description: null,
      at: a.createdAt,
    })),
  ];

  const account: ActivityEntry[] = auditLog.map((entry) => ({
    id: `audit:${entry.id}`,
    category: "account",
    title: titleCase(entry.action),
    description: entry.detail,
    at: entry.createdAt,
  }));

  return [...auth, ...account].sort((a, b) => b.at.getTime() - a.at.getTime());
};

const userSummarySelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  emailVerified: true,
  image: true,
  createdAt: true,
  onboardedAt: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

const listAll = async (req: Request, res: Response): Promise<void> => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE));

    // Built as an AND of conditions, not a flat object, because "active"
    // needs its own OR (below) and a flat object can only hold one OR key —
    // a second assignment would silently clobber the search filter's.
    const and: Prisma.UserWhereInput[] = [];
    if (q) {
      and.push({
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      });
    }
    if (role === "admin" || role === "user") and.push({ role });
    if (status === "active") {
      // `deletedAt: null` alone misses every user created before this field
      // existed: MongoDB has no backfill on `prisma db push`, so those
      // documents don't carry the key at all, and Prisma's null-equality
      // filter on Mongo does not match a missing field (confirmed: it
      // matched 1 of 8 users, the only one with `deletedAt` explicitly
      // written as null). `isSet: false` is what actually catches "missing".
      and.push({ OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] });
    } else if (status === "deleted") {
      // No such gap here: a deleted account always got a real Date written
      // by userController.deleteAccount, so `not: null` already excludes
      // both null and missing correctly (verified: 0 false positives).
      and.push({ deletedAt: { not: null } });
    }
    const where: Prisma.UserWhereInput = and.length ? { AND: and } : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: userSummarySelect,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.status(200).json({ success: true, data: { users, total, page, pageSize } });
  } catch (error) {
    console.error("Admin List Users Error:", error);
    res.status(500).json({ success: false, message: "Could not load users" });
  }
};

const getOne = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        ...userSummarySelect,
        updatedAt: true,
      },
    });
    if (!user) {
      res.status(404).json({ success: false, code: "UNKNOWN_USER", message: "No such user" });
      return;
    }

    const [auditLog, sessions, accounts] = await Promise.all([
      prisma.accountAuditLog.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, action: true, detail: true, createdAt: true },
      }),
      prisma.session.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, createdAt: true, ipAddress: true, userAgent: true },
      }),
      prisma.account.findMany({
        where: { userId: id },
        select: { id: true, providerId: true, createdAt: true },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        user,
        activity: buildActivity(sessions, accounts, auditLog),
      },
    });
  } catch (error) {
    console.error("Admin Get User Error:", error);
    res.status(500).json({ success: false, message: "Could not load this user" });
  }
};

export const adminUsersController = {
  listAll,
  getOne,
};
