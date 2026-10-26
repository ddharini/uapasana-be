import { Request, Response } from "express";

import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { toChangeDto } from "../lib/registration-changes";
import { prisma } from "../utils/db";

/**
 * The Logs screen: edits made to registrations after they were submitted,
 * newest first. Admin only (adminRoutes).
 */

const PAGE_SIZE = 50;

const querySchema = z.object({
  /** "devotee" or "team"; anything else lists both. */
  by: z.enum(["devotee", "team"]).optional().catch(undefined),
  /** Matches the registration code or name, ignoring case. */
  q: z.string().trim().max(80).optional().catch(undefined),
  /** One registration's history. */
  registration: z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .optional()
    .catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});

/** Regex metacharacters escaped, so a search for "DM-0.1" means just that. */
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const list = async (req: Request, res: Response): Promise<void> => {
  const { by, q, registration, page } = querySchema.parse(req.query);
  const where: Prisma.RegistrationChangeWhereInput = {
    ...(by ? { by } : {}),
    ...(registration ? { registrationId: registration } : {}),
    ...(q
      ? {
          OR: [
            { code: { contains: escapeRegex(q), mode: "insensitive" } },
            { name: { contains: escapeRegex(q), mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [changes, total] = await Promise.all([
    prisma.registrationChange.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.registrationChange.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: { changes: changes.map(toChangeDto), total, page, pageSize: PAGE_SIZE },
  });
};

export const registrationChangesController = { list };
