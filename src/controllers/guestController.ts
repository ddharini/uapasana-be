import { Request, Response } from "express";

import { MAX_ENTRIES_PER_HOST, guestVisitSchema } from "../lib/guests";
import { DESK_ROLES } from "../middlewares/authMiddleware";
import { prisma } from "../utils/db";

/**
 * Walk-in guests: people a devotee invites for the day, to attend and eat.
 *
 * Hosts send them in from the public /guests/register link; the team sees,
 * adds, edits and removes them at /guests. A sanchalak works with their own
 * mandal's hosts only, as with registrations.
 */

/** Same 400 shape as registrationController, so the frontend reads both the same way. */
function validationError(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  res.status(400).json({
    success: false,
    code: "VALIDATION_ERROR",
    message: issues[0]?.message ?? "Some details are missing or invalid.",
    errors: issues.map(i => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

/** Prisma rejects a malformed ObjectId with an error, not a null, so it is checked first. */
const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);

const notFound = (res: Response) =>
  res
    .status(404)
    .json({ success: false, code: "NOT_FOUND", message: "That guest entry is no longer there." });

/** What a sanchalak may see: their own mandal's hosts. Everyone else sees all. */
function guestScope(user: { role?: string; mandal?: string | null } | undefined) {
  if (user?.role !== "sanchalak") return {};
  return { hostMandal: user.mandal ?? "\u0000no-mandal" };
}

/** A sanchalak adds and edits only their own mandal's guests. Answers 403 and returns false otherwise. */
function withinMandal(req: Request, res: Response, mandal: string): boolean {
  if (req.user?.role !== "sanchalak" || req.user.mandal === mandal) return true;
  res.status(403).json({
    success: false,
    code: "WRONG_MANDAL",
    message: `You can add and edit guests of ${req.user.mandal ?? "your mandal"} only.`,
    errors: [{ path: "hostMandal", message: `Only ${req.user.mandal ?? "your mandal"}` }],
  });
  return false;
}

/**
 * Public, or the desk. A request with a desk session is recorded as
 * `source: "staff"`; the public link is capped per host number (see
 * MAX_ENTRIES_PER_HOST).
 */
const create = async (req: Request, res: Response): Promise<void> => {
  const parsed = guestVisitSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  const atDesk = DESK_ROLES.has(req.user?.role);
  if (atDesk && !withinMandal(req, res, parsed.data.hostMandal)) return;

  if (!atDesk) {
    const sent = await prisma.guestVisit.count({
      where: { hostMobile: parsed.data.hostMobile, source: "self" },
    });
    if (sent >= MAX_ENTRIES_PER_HOST) {
      res.status(429).json({
        success: false,
        code: "TOO_MANY_ENTRIES",
        message:
          "This number has sent a lot of guest entries already. Please call the team to add more.",
      });
      return;
    }
  }

  const visit = await prisma.guestVisit.create({
    data: {
      ...parsed.data,
      source: atDesk ? "staff" : "self",
      createdById: atDesk ? req.user.id : null,
    },
  });
  res.status(201).json({ success: true, data: visit });
};

/** Every entry the viewer may see, newest first. Small enough to send whole. */
const list = async (req: Request, res: Response): Promise<void> => {
  const visits = await prisma.guestVisit.findMany({
    where: guestScope(req.user),
    orderBy: { createdAt: "desc" },
  });
  res.status(200).json({ success: true, data: visits });
};

const getOne = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const visit = isObjectId(id)
    ? await prisma.guestVisit.findFirst({ where: { id, ...guestScope(req.user) } })
    : null;
  if (!visit) return void notFound(res);
  res.status(200).json({ success: true, data: visit });
};

/** The team correcting an entry: the whole entry, as on the form. */
const update = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const existing = isObjectId(id)
    ? await prisma.guestVisit.findFirst({ where: { id, ...guestScope(req.user) } })
    : null;
  if (!existing) return void notFound(res);

  const parsed = guestVisitSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  if (!withinMandal(req, res, parsed.data.hostMandal)) return;

  const visit = await prisma.guestVisit.update({
    where: { id },
    data: { ...parsed.data, editedAt: new Date(), editedByName: req.user.name },
  });
  res.status(200).json({ success: true, data: visit });
};

/** Removes an entry — a duplicate, or guests who are no longer coming. */
const remove = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const { count } = isObjectId(id)
    ? await prisma.guestVisit.deleteMany({ where: { id, ...guestScope(req.user) } })
    : { count: 0 };
  if (count === 0) return void notFound(res);
  res.status(200).json({ success: true, data: { id } });
};

export const guestController = { create, list, getOne, update, remove };
