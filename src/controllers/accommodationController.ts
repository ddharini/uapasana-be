import { Request, Response } from "express";

import { z } from "zod";
import { Prisma, type AccommodationPlace, type Registration } from "@prisma/client";

import {
  ALLOTTABLE_STATUSES,
  buildStayNotice,
  fullyAllotted,
  nightsOf,
  occupantsOf,
  placeInputSchema,
  roomIssue,
  roomProblem,
  sameNotice,
  stayNoticeLine,
  stayNoticeMessage,
  toAllotmentDto,
  toPlaceDto,
  withRoomIds,
  type Occupant,
  type StayNotice,
} from "../lib/accommodation";
import { EVENT_NAME } from "../lib/event";
import {
  mandalStayInputSchema,
  occupancyFor,
  occupancyInputSchema,
  toMandalStayDto,
} from "../lib/mandal-stays";
import { wantsBed } from "../lib/registrations";
import { WHATSAPP_TEMPLATES, isWhatsAppConfigured, sendWhatsAppTemplate } from "../lib/whatsapp";
import { registrationScope } from "../middlewares/authMiddleware";
import { prisma } from "../utils/db";

/**
 * Accommodation: places and their rooms, and which rooms each mandal was
 * given (src/lib/mandal-stays.ts). The mandal's coordinator decides who
 * sleeps where and reports how many people are in each room.
 *
 * Every desk role reads (`overview`), a sanchalak only their own mandal's
 * rooms. Staff and admins give rooms to mandals; they and the mandal's
 * sanchalak update the occupancy; only admins add or change places.
 *
 * PAUSED 2026-10-11: per-person allotment — `allotmentOverview`, `allot`,
 * `release`, `sendNotice`, `sendAllNotices` below. Their routes are commented
 * out in accommodationRoutes.ts; the code is kept so it can come back. See
 * src/lib/accommodation.ts for its rules.
 */

const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Unknown id");

function validationError(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  res.status(400).json({
    success: false,
    code: "VALIDATION_ERROR",
    message: issues[0]?.message ?? "Some details are missing or invalid.",
    errors: issues.map(i => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

/** A refusal decided inside a transaction, answered once it has rolled back. */
class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const refuse = (res: Response, refusal: Refusal) =>
  res.status(refusal.status).json({ success: false, code: refusal.code, message: refusal.message });

/**
 * Runs a transaction, again if MongoDB aborted it because another one wrote
 * the same place at the same time (Prisma's P2034). The second attempt sees
 * the other's beds, so the room checks are made against what is really there.
 */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const conflict =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!conflict || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 40 * attempt));
    }
  }
}

const byOrder = { orderBy: [{ sortOrder: "asc" as const }, { name: "asc" as const }] };

/** What the team was last told, against what is allotted now. */
function noticeState(registration: Registration, current: StayNotice | null) {
  return {
    registrationId: registration.id,
    sentAt: registration.stayNoticeSentAt?.toISOString(),
    sentByName: registration.stayNoticeSentByName ?? undefined,
    // Sent, and nothing about anyone's room has changed since.
    upToDate:
      !!registration.stayNoticeSentAt && !!current && sameNotice(current, registration.stayNotice),
  };
}

/**
 * Everything the Accommodation screens need in one go: places with their
 * rooms, and the rooms given to mandals — every mandal's for staff and
 * admins, only their own for a sanchalak.
 */
const overview = async (req: Request, res: Response): Promise<void> => {
  const scope = registrationScope(req.user);
  const [places, mandalStays] = await Promise.all([
    prisma.accommodationPlace.findMany(byOrder),
    prisma.mandalStay.findMany({ where: scope, orderBy: { mandal: "asc" } }),
  ]);
  res.status(200).json({
    success: true,
    data: { places: places.map(toPlaceDto), mandalStays: mandalStays.map(toMandalStayDto) },
  });
};

/**
 * PAUSED 2026-10-11 (per-person allotment). Was `GET /accommodation`.
 *
 * Everything the Accommodation screens need in one go: places with rooms,
 * every allotment the viewer may see, and for each registration with rooms
 * whether its room details were sent and are still right.
 */
const allotmentOverview = async (req: Request, res: Response): Promise<void> => {
  const scope = registrationScope(req.user);
  const scoped = "mandal" in scope;

  const [places, allAllotments] = await Promise.all([
    prisma.accommodationPlace.findMany(byOrder),
    prisma.roomAllotment.findMany(),
  ]);
  const registrations = await prisma.registration.findMany({
    where: { id: { in: [...new Set(allAllotments.map(a => a.registrationId))] }, ...scope },
  });
  const visible = new Set(registrations.map(r => r.id));
  const allotments = scoped
    ? allAllotments.filter(a => visible.has(a.registrationId))
    : allAllotments;
  const placeMap = new Map(places.map(p => [p.id, p]));

  res.status(200).json({
    success: true,
    data: {
      places: places.map(toPlaceDto),
      allotments: allotments.map(toAllotmentDto),
      notices: registrations
        .filter(r => r.stayNoticeSentAt || allotments.some(a => a.registrationId === r.id))
        .map(r => noticeState(r, buildStayNotice(r, allotments, placeMap))),
      whatsApp: isWhatsAppConfigured(),
    },
  });
};

const createPlace = async (req: Request, res: Response): Promise<void> => {
  const parsed = placeInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  const last = await prisma.accommodationPlace.findFirst({ orderBy: { sortOrder: "desc" } });
  try {
    const place = await prisma.accommodationPlace.create({
      data: {
        ...parsed.data,
        rooms: withRoomIds(parsed.data.rooms),
        sortOrder: (last?.sortOrder ?? 0) + 1,
      },
    });
    res.status(201).json({ success: true, data: toPlaceDto(place) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res
        .status(409)
        .json({
          success: false,
          code: "NAME_TAKEN",
          message: `There is already a place called ${parsed.data.name}.`,
        });
      return;
    }
    throw error;
  }
};

/**
 * Changes a place's details and rooms. A room given to a mandal cannot be
 * removed — take it back from the mandal first — but its beds, type and
 * floor can change: the coordinator works within whatever the room is.
 */
const updatePlace = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!isObjectId(id))
    return void res
      .status(404)
      .json({ success: false, code: "NOT_FOUND", message: "Place not found" });
  const parsed = placeInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  try {
    const place = await withRetry(() =>
      prisma.$transaction(async tx => {
        const existing = await tx.accommodationPlace.findUnique({ where: { id } });
        if (!existing) throw new Refusal(404, "NOT_FOUND", "Place not found");
        const rooms = withRoomIds(
          parsed.data.rooms,
          existing.rooms.map(r => r.id)
        );

        const stays = await tx.mandalStay.findMany({ where: { placeId: id } });
        for (const old of existing.rooms) {
          if (rooms.some(r => r.id === old.id)) continue;
          const holder = stays.find(st => st.roomIds.includes(old.id));
          if (holder) {
            throw new Refusal(
              409,
              "ROOM_IN_USE",
              `Room ${old.label} is given to ${holder.mandal} — take it back from them first.`
            );
          }
        }

        // PAUSED 2026-10-11 (per-person allotment): a room with people
        // allotted to it could not be removed or changed into something they
        // no longer fit.
        //
        // const allotments = await tx.roomAllotment.findMany({ where: { placeId: id } });
        // const registrations = new Map(
        //   (
        //     await tx.registration.findMany({
        //       where: { id: { in: [...new Set(allotments.map(a => a.registrationId))] } },
        //     })
        //   ).map(r => [r.id, r])
        // );
        // for (const old of existing.rooms) {
        //   const inRoom = allotments.filter(a => a.roomId === old.id);
        //   if (inRoom.length === 0) continue;
        //   const now = rooms.find(r => r.id === old.id);
        //   if (!now) {
        //     throw new Refusal(
        //       409,
        //       "ROOM_IN_USE",
        //       `Room ${old.label} has people in it — move them to another room first.`
        //     );
        //   }
        //   const problem = roomProblem(now, occupantsOf(inRoom, registrations));
        //   if (problem) throw new Refusal(409, "ROOM_IN_USE", `${problem}. Move someone out first.`);
        // }

        return tx.accommodationPlace.update({
          where: { id },
          data: { ...parsed.data, rooms, version: { increment: 1 } },
        });
      })
    );
    res.status(200).json({ success: true, data: toPlaceDto(place) });
  } catch (error) {
    if (error instanceof Refusal) return void refuse(res, error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res
        .status(409)
        .json({
          success: false,
          code: "NAME_TAKEN",
          message: `There is already a place called ${parsed.data.name}.`,
        });
      return;
    }
    throw error;
  }
};

const deletePlace = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const place = isObjectId(id)
    ? await prisma.accommodationPlace.findUnique({ where: { id } })
    : null;
  if (!place)
    return void res
      .status(404)
      .json({ success: false, code: "NOT_FOUND", message: "Place not found" });
  const stays = await prisma.mandalStay.findMany({ where: { placeId: id }, select: { mandal: true } });
  if (stays.length > 0) {
    res.status(409).json({
      success: false,
      code: "PLACE_IN_USE",
      message: `Rooms at ${place.name} are given to ${stays.map(st => st.mandal).join(", ")}. Take them back before removing it.`,
    });
    return;
  }
  // PAUSED 2026-10-11 (per-person allotment): refused while anyone was allotted here.
  // const used = await prisma.roomAllotment.count({ where: { placeId: id } });
  // if (used > 0) {
  //   res.status(409).json({
  //     success: false,
  //     code: "PLACE_IN_USE",
  //     message: `${used} ${used === 1 ? "person is" : "people are"} staying at ${place.name}. Move them before removing it.`,
  //   });
  //   return;
  // }
  await prisma.accommodationPlace.delete({ where: { id } });
  res.status(200).json({ success: true, data: { id } });
};

/**
 * Saves a mandal's rooms at a place: new (no id) or changed. Inside a
 * transaction that writes the place first, so two team members giving away
 * the same room at once cannot both succeed. A room another mandal has is
 * refused; occupancy reported for a room the mandal no longer has is dropped.
 */
async function saveMandalStay(req: Request, res: Response, id?: string) {
  const parsed = mandalStayInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const input = parsed.data;

  try {
    const stay = await withRetry(() =>
      prisma.$transaction(async tx => {
        const existing = id ? await tx.mandalStay.findUnique({ where: { id } }) : null;
        if (id && !existing) throw new Refusal(404, "NOT_FOUND", "Those rooms were already taken back.");
        // Moving a mandal's rooms to another place is a new entry there.
        if (existing && existing.placeId !== input.placeId) {
          throw new Refusal(400, "PLACE_CHANGED", "Rooms can't move to another place. Add them there instead.");
        }

        const place = await tx.accommodationPlace
          .update({ where: { id: input.placeId }, data: { version: { increment: 1 } } })
          .catch((error: unknown) => {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
              throw new Refusal(404, "NOT_FOUND", "That place no longer exists. Reload and try again.");
            }
            throw error;
          });

        const unknown = input.roomIds.filter(roomId => !place.rooms.some(r => r.id === roomId));
        if (unknown.length > 0) {
          throw new Refusal(409, "ROOM_GONE", "A room you picked was removed from the place. Reload and try again.");
        }
        const others = await tx.mandalStay.findMany({
          where: { placeId: input.placeId, ...(id ? { id: { not: id } } : {}) },
        });
        const sameMandal = others.find(o => o.mandal === input.mandal);
        if (sameMandal) {
          throw new Refusal(
            409,
            "MANDAL_TAKEN",
            `${input.mandal} already has rooms at ${place.name}. Change those instead.`
          );
        }
        const label = (roomId: string) => place.rooms.find(r => r.id === roomId)?.label ?? roomId;
        for (const other of others) {
          const clash = input.roomIds.filter(roomId => other.roomIds.includes(roomId));
          if (clash.length > 0) {
            throw new Refusal(
              409,
              "ROOM_TAKEN",
              `${clash.length === 1 ? "Room" : "Rooms"} ${clash.map(label).join(", ")} ${clash.length === 1 ? "is" : "are"} already given to ${other.mandal}.`
            );
          }
        }

        const data = {
          mandal: input.mandal,
          coordinatorName: input.coordinatorName,
          coordinatorMobile: input.coordinatorMobile,
          notes: input.notes,
          roomIds: input.roomIds,
        };
        return existing
          ? tx.mandalStay.update({
              where: { id: existing.id },
              data: { ...data, occupancy: occupancyFor(input.roomIds, existing.occupancy) },
            })
          : tx.mandalStay.create({
              data: { ...data, placeId: input.placeId, occupancy: [], createdByName: req.user.name },
            });
      })
    );
    res.status(id ? 200 : 201).json({ success: true, data: toMandalStayDto(stay) });
  } catch (error) {
    if (error instanceof Refusal) return void refuse(res, error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({
        success: false,
        code: "MANDAL_TAKEN",
        message: `${input.mandal} already has rooms at this place. Change those instead.`,
      });
      return;
    }
    throw error;
  }
}

const createMandalStay = (req: Request, res: Response) => saveMandalStay(req, res);

const updateMandalStay = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!isObjectId(id))
    return void res.status(404).json({ success: false, code: "NOT_FOUND", message: "Not found" });
  await saveMandalStay(req, res, id);
};

/** Takes every room back from a mandal at a place, with its occupancy. */
const deleteMandalStay = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const deleted = isObjectId(id)
    ? await prisma.mandalStay.deleteMany({ where: { id } })
    : { count: 0 };
  if (deleted.count === 0)
    return void res.status(404).json({ success: false, code: "NOT_FOUND", message: "Already taken back" });
  res.status(200).json({ success: true, data: { id } });
};

/**
 * The coordinator's report: how many people are in each of the mandal's
 * rooms. Staff and admins for any mandal; a sanchalak only for their own.
 * Every room the mandal has may be sent, and replaces what was there.
 */
const updateOccupancy = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const stay = isObjectId(id)
    ? await prisma.mandalStay.findFirst({ where: { id, ...registrationScope(req.user) } })
    : null;
  if (!stay)
    return void res.status(404).json({ success: false, code: "NOT_FOUND", message: "Not found" });
  const parsed = occupancyInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  const reported = new Map(parsed.data.rooms.map(r => [r.roomId, r.people]));
  if ([...reported.keys()].some(roomId => !stay.roomIds.includes(roomId))) {
    res.status(409).json({
      success: false,
      code: "ROOM_GONE",
      message: "A room was taken back from the mandal meanwhile. Reload and try again.",
    });
    return;
  }
  // Rooms not sent keep what they had.
  const occupancy = stay.roomIds.flatMap(roomId => {
    const people = reported.get(roomId) ?? stay.occupancy.find(o => o.roomId === roomId)?.people;
    return people === undefined ? [] : [{ roomId, people }];
  });
  const saved = await prisma.mandalStay.update({
    where: { id },
    data: { occupancy, occupancyUpdatedAt: new Date(), occupancyUpdatedByName: req.user.name },
  });
  res.status(200).json({ success: true, data: toMandalStayDto(saved) });
};

// ---------------------------------------------------------------------------
// PAUSED 2026-10-11: per-person allotment and room-detail notices. Nothing
// routes here any more (see accommodationRoutes.ts); kept to bring it back.
// ---------------------------------------------------------------------------

const assignment = z.object({
  memberId: z.string().max(40),
  placeId: objectId,
  roomId: z.string().min(1).max(40),
});

/**
 * Either a plan — each person with their own room, so a family split across
 * two rooms is saved in one go — or the older shape, everyone into one room.
 */
const allotSchema = z.union([
  z.object({
    registrationId: objectId,
    assignments: z.array(assignment).min(1, "Pick who goes where").max(100),
    /** Let them share a family room another registration has — relatives. */
    allowSharing: z.boolean().optional(),
  }),
  z
    .object({
      registrationId: objectId,
      memberIds: z.array(z.string().max(40)).min(1, "Pick who goes in this room").max(100),
      placeId: objectId,
      roomId: z.string().min(1).max(40),
      allowSharing: z.boolean().optional(),
    })
    .transform(({ registrationId, memberIds, placeId, roomId, allowSharing }) => ({
      registrationId,
      assignments: memberIds.map(memberId => ({ memberId, placeId, roomId })),
      allowSharing,
    })),
]);

/** The registration's allotments after a change, for the response. */
const allotmentsOf = (registrationId: string) =>
  prisma.roomAllotment
    .findMany({ where: { registrationId } })
    .then(rows => rows.map(toAllotmentDto));

/**
 * Puts a registration's people in rooms — one room for everyone, or a plan
 * with a room each — moving anyone who had a room already. Every room the
 * plan touches is checked with everyone who will be in it, inside one
 * transaction that also writes each place involved, so two volunteers filling
 * the same room at once cannot both get its last bed, and a plan is saved
 * whole or not at all.
 */
const allot = async (req: Request, res: Response): Promise<void> => {
  const parsed = allotSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const { registrationId } = parsed.data;
  // One room per person: the last one given wins if someone is listed twice.
  const plan = new Map(parsed.data.assignments.map(a => [a.memberId, a]));
  const memberIds = [...plan.keys()];

  const registration = await prisma.registration.findUnique({ where: { id: registrationId } });
  if (!registration)
    return void res
      .status(404)
      .json({ success: false, code: "NOT_FOUND", message: "Registration not found" });
  if (!ALLOTTABLE_STATUSES.has(registration.status)) {
    res.status(409).json({
      success: false,
      code: "NOT_CONFIRMED",
      message: `${registration.code} is cancelled.`,
    });
    return;
  }
  if (!registration.accommodationRequired) {
    res.status(409).json({
      success: false,
      code: "NO_STAY_REQUESTED",
      message: `${registration.code} did not ask for accommodation. Tick it on the registration first.`,
    });
    return;
  }
  const members = memberIds.map(id => registration.members.find(m => m.id === id));
  if (members.some(m => !m)) {
    res
      .status(400)
      .json({
        success: false,
        code: "UNKNOWN_MEMBER",
        message: "Someone picked is no longer on this registration. Reload and try again.",
      });
    return;
  }
  const noBedAsked = members.find(m => m && !wantsBed(registration, m));
  if (noBedAsked) {
    res.status(409).json({
      success: false,
      code: "NO_STAY_REQUESTED",
      message: `${noBedAsked.fullName} did not ask for accommodation. Tick it for them on the registration first.`,
    });
    return;
  }
  const sameDay = members.find(m => m && nightsOf(m).length === 0);
  if (sameDay) {
    res.status(409).json({
      success: false,
      code: "NO_NIGHTS",
      message: `${sameDay.fullName} leaves the day they arrive — there is no night to give a bed for.`,
    });
    return;
  }

  try {
    await withRetry(() =>
      prisma.$transaction(async tx => {
        // Writing each place first is what makes a concurrent allotment into
        // it conflict, instead of both reading the same free bed.
        const placeIds = [...new Set([...plan.values()].map(a => a.placeId))].sort();
        const places = new Map<string, AccommodationPlace>();
        for (const placeId of placeIds) {
          const place = await tx.accommodationPlace
            .update({ where: { id: placeId }, data: { version: { increment: 1 } } })
            .catch((error: unknown) => {
              if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
                throw new Refusal(404, "NOT_FOUND", "That place no longer exists. Reload and try again.");
              }
              throw error;
            });
          places.set(placeId, place);
        }

        // Who was let into another family's room, to store with their bed.
        const sharing = new Map<string, boolean>();

        // Each room the plan fills, with the people already there (not
        // counting anyone in this plan — they are moving) and those coming.
        const rooms = new Map<string, { placeId: string; roomId: string; incoming: Occupant[] }>();
        members.forEach(m => {
          const { placeId, roomId } = plan.get(m!.id)!;
          const key = `${placeId}:${roomId}`;
          const entry = rooms.get(key) ?? { placeId, roomId, incoming: [] };
          entry.incoming.push({
            registrationId,
            memberId: m!.id,
            fullName: m!.fullName,
            gender: m!.gender,
            age: m!.age,
            nights: nightsOf(m!),
            shared: false,
          });
          rooms.set(key, entry);
        });

        for (const { placeId, roomId, incoming } of rooms.values()) {
          const place = places.get(placeId)!;
          const room = place.rooms.find(r => r.id === roomId);
          if (!room)
            throw new Refusal(404, "NOT_FOUND", "A room in this plan no longer exists. Reload and try again.");
          const inRoom = await tx.roomAllotment.findMany({ where: { placeId, roomId } });
          const others = inRoom.filter(
            a => !(a.registrationId === registrationId && plan.has(a.memberId))
          );
          const otherRegistrations = new Map(
            (
              await tx.registration.findMany({
                where: { id: { in: [...new Set(others.map(a => a.registrationId))] } },
              })
            ).map(r => [r.id, r])
          );
          const already = occupantsOf(others, otherRegistrations);
          let issue = roomIssue(room, [...already, ...incoming]);
          // Relatives registered separately: the team may let them share
          // another registration's family room. Only that rule gives way.
          if (issue?.kind === "family" && parsed.data.allowSharing) {
            incoming.forEach(o => (o.shared = true));
            issue = roomIssue(room, [...already, ...incoming]);
          }
          if (issue) throw new Refusal(409, "ROOM_PROBLEM", `${place.name}: ${issue.message}.`);
          incoming.forEach(o => sharing.set(o.memberId, o.shared));
        }

        for (const [memberId, { placeId, roomId }] of plan) {
          const sharesRoom = sharing.get(memberId) ?? false;
          await tx.roomAllotment.upsert({
            where: { registrationId_memberId: { registrationId, memberId } },
            create: { registrationId, memberId, placeId, roomId, sharesRoom, allottedByName: req.user.name },
            update: { placeId, roomId, sharesRoom, allottedByName: req.user.name, allottedAt: new Date() },
          });
        }
      })
    );
  } catch (error) {
    if (error instanceof Refusal) return void refuse(res, error);
    throw error;
  }

  res.status(200).json({ success: true, data: await allotmentsOf(registrationId) });
};

const releaseSchema = z.object({
  registrationId: objectId,
  memberIds: z.array(z.string().max(40)).min(1, "Pick who to take out of their room").max(100),
});

/** Takes people out of their rooms. Allowed whatever the status: freeing a bed is never wrong. */
const release = async (req: Request, res: Response): Promise<void> => {
  const parsed = releaseSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const { registrationId, memberIds } = parsed.data;
  await prisma.roomAllotment.deleteMany({ where: { registrationId, memberId: { in: memberIds } } });
  res.status(200).json({ success: true, data: await allotmentsOf(registrationId) });
};

/** The registration with its current notice, or a refusal. */
async function noticeFor(id: string) {
  const registration = isObjectId(id)
    ? await prisma.registration.findUnique({ where: { id } })
    : null;
  if (!registration) throw new Refusal(404, "NOT_FOUND", "Registration not found");
  if (!ALLOTTABLE_STATUSES.has(registration.status)) {
    throw new Refusal(
      409,
      "NOT_CONFIRMED",
      `${registration.code} is not confirmed, so its room details are not final.`
    );
  }
  const [allotments, places] = await Promise.all([
    prisma.roomAllotment.findMany({ where: { registrationId: id } }),
    prisma.accommodationPlace.findMany(),
  ]);
  const notice = buildStayNotice(registration, allotments, new Map(places.map(p => [p.id, p])));
  if (!notice)
    throw new Refusal(409, "NOTHING_ALLOTTED", `Nobody in ${registration.code} has a room yet.`);
  const contact = registration.contactMobile ?? registration.members[0]?.mobile;
  if (!contact)
    throw new Refusal(409, "NO_CONTACT", `${registration.code} has no contact number to send to.`);
  return { registration, notice, contact, complete: fullyAllotted(registration, allotments) };
}

function recordSent(registration: Registration, notice: StayNotice, by: string) {
  return prisma.registration.update({
    where: { id: registration.id },
    data: {
      stayNotice: notice as unknown as Prisma.InputJsonValue,
      stayNoticeSentAt: new Date(),
      stayNoticeSentByName: by,
    },
  });
}

const sendTo = (registration: Registration, notice: StayNotice, contact: string) =>
  sendWhatsAppTemplate({
    to: contact,
    template: WHATSAPP_TEMPLATES.stayDetails(),
    body: [registration.members[0]?.fullName ?? "", EVENT_NAME, stayNoticeLine(notice)],
    usage: { endpoint: "whatsapp:stay-details" },
  });

const noticeSchema = z.object({
  /** The team member sent it from their own WhatsApp; just record it. */
  manual: z.boolean().optional(),
});

/**
 * Sends one registration its room details on WhatsApp. Without WhatsApp set
 * up on the server, answers with the message and a wa.me link instead, so a
 * team member can send it from their own phone and then mark it sent
 * (`manual: true`).
 */
const sendNotice = async (req: Request, res: Response): Promise<void> => {
  const parsed = noticeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error.issues);

  let found: Awaited<ReturnType<typeof noticeFor>>;
  try {
    found = await noticeFor(String(req.params.id));
  } catch (error) {
    if (error instanceof Refusal) return void refuse(res, error);
    throw error;
  }
  const { registration, notice, contact } = found;

  if (parsed.data.manual) {
    await recordSent(registration, notice, req.user.name);
    res.status(200).json({ success: true, data: { sent: true, channel: "manual" } });
    return;
  }

  if (!isWhatsAppConfigured()) {
    const message = stayNoticeMessage(registration, notice);
    res.status(200).json({
      success: true,
      data: {
        sent: false,
        message,
        whatsappUrl: `https://wa.me/${contact.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`,
      },
    });
    return;
  }

  try {
    await sendTo(registration, notice, contact);
  } catch (error) {
    console.error(`[WhatsApp] Room details for ${registration.code} failed:`, error);
    res.status(502).json({
      success: false,
      code: "SEND_FAILED",
      message: "WhatsApp did not accept the message. Try again, or send it from your own phone.",
    });
    return;
  }
  await recordSent(registration, notice, req.user.name);
  res.status(200).json({ success: true, data: { sent: true, channel: "whatsapp" } });
};

/**
 * "Send all": room details to every confirmed registration whose people all
 * have rooms and who has not been told — or was told something that has
 * changed since. Needs WhatsApp on the server; one by one is the fallback.
 */
const sendAllNotices = async (req: Request, res: Response): Promise<void> => {
  if (!isWhatsAppConfigured()) {
    res.status(503).json({
      success: false,
      code: "WHATSAPP_NOT_CONFIGURED",
      message:
        "WhatsApp is not set up on the server yet. Send room details one by one from your own phone.",
    });
    return;
  }

  const [allotments, places] = await Promise.all([
    prisma.roomAllotment.findMany(),
    prisma.accommodationPlace.findMany(),
  ]);
  const placeMap = new Map<string, AccommodationPlace>(places.map(p => [p.id, p]));
  const registrations = await prisma.registration.findMany({
    where: {
      id: { in: [...new Set(allotments.map(a => a.registrationId))] },
      status: { in: [...ALLOTTABLE_STATUSES] },
    },
    orderBy: { sequence: "asc" },
  });

  let sent = 0;
  let incomplete = 0;
  const failed: string[] = [];
  for (const registration of registrations) {
    const notice = buildStayNotice(registration, allotments, placeMap);
    if (!notice || (registration.stayNoticeSentAt && sameNotice(notice, registration.stayNotice)))
      continue;
    if (!fullyAllotted(registration, allotments)) {
      incomplete++;
      continue;
    }
    const contact = registration.contactMobile ?? registration.members[0]?.mobile;
    if (!contact) {
      failed.push(registration.code);
      continue;
    }
    try {
      await sendTo(registration, notice, contact);
      await recordSent(registration, notice, req.user.name);
      sent++;
    } catch (error) {
      console.error(`[WhatsApp] Room details for ${registration.code} failed:`, error);
      failed.push(registration.code);
    }
  }

  res.status(200).json({ success: true, data: { sent, failed, incomplete } });
};

export const accommodationController = {
  overview,
  createPlace,
  updatePlace,
  deletePlace,
  createMandalStay,
  updateMandalStay,
  deleteMandalStay,
  updateOccupancy,
  // Paused per-person allotment.
  allotmentOverview,
  allot,
  release,
  sendNotice,
  sendAllNotices,
};
