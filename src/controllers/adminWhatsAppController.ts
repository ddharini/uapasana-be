import { Request, Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "../utils/db";

/**
 * The WhatsApp screen (/admin/whatsapp): what we sent and what became of it,
 * and what devotees wrote back. Admin only (adminRoutes) — the owner's call,
 * 2026-10-19: replies carry devotees' own words and numbers.
 */

const PAGE_SIZE = 50;

const pageSchema = z.coerce.number().int().min(1).max(10_000).catch(1);
/** A number, or part of one: digits only, so "+91 98765" and "9876 5" both search. */
const numberSearch = z
  .string()
  .transform(text => text.replace(/\D/g, ""))
  .pipe(z.string().max(15))
  .optional()
  .catch(undefined);

const messagesQuery = z.object({
  status: z.enum(["accepted", "sent", "delivered", "read", "failed"]).optional().catch(undefined),
  q: numberSearch,
  page: pageSchema,
});

const repliesQuery = z.object({ q: numberSearch, page: pageSchema });

/** Code and name for the registrations these rows point at, in one query. */
async function registrationsById(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, { code: string; name: string }>();
  const found = await prisma.registration.findMany({
    where: { id: { in: wanted } },
    select: { id: true, code: true, groupName: true, members: { select: { fullName: true } } },
  });
  return new Map(
    found.map(r => [r.id, { code: r.code, name: r.groupName || r.members[0]?.fullName || r.code }])
  );
}

const listMessages = async (req: Request, res: Response): Promise<void> => {
  const { status, q, page } = messagesQuery.parse(req.query);
  const where: Prisma.WhatsAppMessageWhereInput = {
    ...(status ? { status } : {}),
    ...(q ? { to: { contains: q } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.whatsAppMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.whatsAppMessage.count({ where }),
  ]);
  const registrations = await registrationsById(rows.map(r => r.registrationId));

  res.status(200).json({
    success: true,
    data: {
      messages: rows.map(r => ({
        id: r.id,
        to: r.to,
        template: r.template,
        language: r.language,
        purpose: r.purpose,
        status: r.status,
        errorCode: r.errorCode ?? undefined,
        errorMessage: r.errorMessage ?? undefined,
        registration: r.registrationId
          ? { id: r.registrationId, ...registrations.get(r.registrationId) }
          : undefined,
        createdAt: r.createdAt.toISOString(),
        sentAt: r.sentAt?.toISOString(),
        deliveredAt: r.deliveredAt?.toISOString(),
        readAt: r.readAt?.toISOString(),
        failedAt: r.failedAt?.toISOString(),
      })),
      total,
      page,
      pageSize: PAGE_SIZE,
    },
  });
};

const listReplies = async (req: Request, res: Response): Promise<void> => {
  const { q, page } = repliesQuery.parse(req.query);
  const where: Prisma.WhatsAppInboundWhereInput = q ? { from: { contains: q } } : {};
  const [rows, total] = await Promise.all([
    prisma.whatsAppInbound.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.whatsAppInbound.count({ where }),
  ]);
  const registrations = await registrationsById(rows.map(r => r.registrationId));

  res.status(200).json({
    success: true,
    data: {
      replies: rows.map(r => ({
        id: r.id,
        from: r.from,
        profileName: r.profileName ?? undefined,
        type: r.type,
        text: r.text ?? undefined,
        registration: r.registrationId
          ? { id: r.registrationId, ...registrations.get(r.registrationId) }
          : undefined,
        receivedAt: r.receivedAt.toISOString(),
      })),
      total,
      page,
      pageSize: PAGE_SIZE,
    },
  });
};

export const adminWhatsAppController = { listMessages, listReplies };
