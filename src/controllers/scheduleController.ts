import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { Request, Response } from "express";

import { daySchema, sessionSchema, snapshotOf, toDayDto } from "../lib/schedule";
import { prisma } from "../utils/db";

/**
 * The event programme: days, and the sessions within each.
 *
 * Admins edit a draft (the `ScheduleDay` collection) and press Publish to copy
 * it into a `SchedulePublication`. Devotees only ever read the newest
 * publication, through the public `published` endpoint — so a half-finished
 * edit never reaches them. Everything except `published` is admin-only (see
 * scheduleRoutes.ts).
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

function notFound(res: Response) {
  res
    .status(404)
    .json({ success: false, code: "NOT_FOUND", message: "That day is no longer in the schedule." });
}

function dateTaken(res: Response, date: string) {
  res
    .status(409)
    .json({ success: false, code: "DATE_TAKEN", message: `${date} is already in the schedule.` });
}

const isUniqueClash = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** Prisma rejects a malformed ObjectId with an error, not a null, so it is checked first. */
const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);

const edited = (req: Request) => ({ editedAt: new Date(), editedByName: req.user.name as string });

const latestPublication = () =>
  prisma.schedulePublication.findFirst({ orderBy: { publishedAt: "desc" } });

/**
 * The draft, plus where it stands against what devotees see: when it was last
 * published and by whom, and whether the draft has changed since.
 */
async function draftState() {
  const [days, latest] = await Promise.all([
    prisma.scheduleDay.findMany({ orderBy: { date: "asc" } }),
    latestPublication(),
  ]);
  const unpublishedChanges = latest
    ? JSON.stringify(snapshotOf(days)) !== JSON.stringify(latest.days)
    : days.length > 0;
  return {
    days: days.map(toDayDto),
    publication: latest
      ? { publishedAt: latest.publishedAt, publishedByName: latest.publishedByName }
      : null,
    unpublishedChanges,
  };
}

/** The admin's view: every draft day, sessions in time order, and the publish status. */
const list = async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, data: await draftState() });
};

/** Copies the draft, as it is right now, to what devotees see. */
const publish = async (req: Request, res: Response): Promise<void> => {
  const days = await prisma.scheduleDay.findMany({ orderBy: { date: "asc" } });
  await prisma.schedulePublication.create({
    data: {
      days: snapshotOf(days),
      publishedById: req.user.id,
      publishedByName: req.user.name,
    },
  });
  res.status(201).json({ success: true, data: await draftState() });
};

/**
 * Public: the newest published programme, for devotees. Never the draft.
 * Empty `days` and a null `publishedAt` until the first publish.
 *
 * Cached briefly by browsers and any proxy in front, which matters when a
 * link goes out to a few thousand phones at once; a publish shows within a
 * minute.
 */
const published = async (_req: Request, res: Response): Promise<void> => {
  const latest = await latestPublication();
  res.set("Cache-Control", "public, max-age=30");
  res.status(200).json({
    success: true,
    data: { days: latest?.days ?? [], publishedAt: latest?.publishedAt ?? null },
  });
};

const createDay = async (req: Request, res: Response): Promise<void> => {
  const parsed = daySchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const { date, theme } = parsed.data;

  try {
    const day = await prisma.scheduleDay.create({
      data: { date, theme: theme ?? null, sessions: [], ...edited(req) },
    });
    res.status(201).json({ success: true, data: toDayDto(day) });
  } catch (error) {
    if (isUniqueClash(error)) return dateTaken(res, date);
    throw error;
  }
};

/** Changes a day's date or theme. Its sessions move with it. */
const updateDay = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const parsed = daySchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const { date, theme } = parsed.data;
  if (!isObjectId(id)) return notFound(res);

  try {
    const day = await prisma.scheduleDay.update({
      where: { id },
      data: { date, theme: theme ?? null, ...edited(req) },
    });
    res.status(200).json({ success: true, data: toDayDto(day) });
  } catch (error) {
    if (isUniqueClash(error)) return dateTaken(res, date);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")
      return notFound(res);
    throw error;
  }
};

/** Removes a day and every session in it. */
const deleteDay = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const { count } = isObjectId(id)
    ? await prisma.scheduleDay.deleteMany({ where: { id } })
    : { count: 0 };
  if (count === 0) return notFound(res);
  res.status(200).json({ success: true, data: { id } });
};

/**
 * Adds a session to a day. There is no position to send: the timeline is in
 * time order, so a session lands between two others by its start time.
 */
const createSession = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  if (!isObjectId(id) || (await prisma.scheduleDay.count({ where: { id } })) === 0)
    return notFound(res);

  const { note, place, mapUrl, ...rest } = parsed.data;
  // `push` is a single atomic update, so two admins adding at once both land.
  const day = await prisma.scheduleDay.update({
    where: { id },
    data: {
      sessions: {
        push: {
          id: randomUUID(),
          ...rest,
          place: place ?? null,
          mapUrl: mapUrl ?? null,
          note: note ?? null,
        },
      },
      ...edited(req),
    },
  });
  res.status(201).json({ success: true, data: toDayDto(day) });
};

const updateSession = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const sessionId = String(req.params.sessionId);
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  const day = isObjectId(id) ? await prisma.scheduleDay.findUnique({ where: { id } }) : null;
  if (!day) return notFound(res);
  if (!day.sessions.some(s => s.id === sessionId)) {
    res
      .status(404)
      .json({ success: false, code: "NOT_FOUND", message: "That session has been removed." });
    return;
  }

  const { note, place, mapUrl, ...rest } = parsed.data;
  const updated = await prisma.scheduleDay.update({
    where: { id },
    data: {
      sessions: {
        updateMany: {
          where: { id: sessionId },
          data: { ...rest, place: place ?? null, mapUrl: mapUrl ?? null, note: note ?? null },
        },
      },
      ...edited(req),
    },
  });
  res.status(200).json({ success: true, data: toDayDto(updated) });
};

/** Idempotent: deleting a session that is already gone succeeds. */
const deleteSession = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const sessionId = String(req.params.sessionId);
  if (!isObjectId(id) || (await prisma.scheduleDay.count({ where: { id } })) === 0)
    return notFound(res);

  const day = await prisma.scheduleDay.update({
    where: { id },
    data: { sessions: { deleteMany: { where: { id: sessionId } } }, ...edited(req) },
  });
  res.status(200).json({ success: true, data: toDayDto(day) });
};

export const scheduleController = {
  list,
  publish,
  published,
  createDay,
  updateDay,
  deleteDay,
  createSession,
  updateSession,
  deleteSession,
};
