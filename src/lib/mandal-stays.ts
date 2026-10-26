import { z } from "zod";
import type { MandalStay } from "@prisma/client";

import { MANDALS, MOBILE_E164 } from "./event";

/**
 * Rooms given to mandals. The team hands a mandal some rooms at a place — "20
 * rooms at Gurukul – Memnagar for Surat" — and the mandal's coordinator
 * decides who sleeps where, reporting back how many people are in each room
 * so the admin screens show how full each place is.
 *
 * Replaced per-person allotment (src/lib/accommodation.ts, paused) on
 * 2026-10-11.
 */

/** Most people one room can be reported to hold; a sanity limit, not a rule. */
export const MAX_PEOPLE_IN_ROOM = 50;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform(v => (v ? v : null));

export const mandalStayInputSchema = z.object({
  placeId: z.string().regex(/^[a-f\d]{24}$/i, "Unknown place"),
  mandal: z.enum(MANDALS, { error: "Pick a mandal from the list" }),
  coordinatorName: z.string().trim().min(2, "Enter the coordinator's name").max(120),
  coordinatorMobile: z.string().regex(MOBILE_E164, "Enter a valid mobile number"),
  notes: optionalText(1000),
  roomIds: z
    .array(z.string().min(1).max(40))
    .min(1, "Pick at least one room")
    .max(500)
    .transform(ids => [...new Set(ids)]),
});

export type MandalStayInput = z.infer<typeof mandalStayInputSchema>;

export const occupancyInputSchema = z.object({
  rooms: z
    .array(
      z.object({
        roomId: z.string().min(1).max(40),
        people: z
          .number({ error: "Enter how many people" })
          .int("Enter a whole number")
          .min(0, "Can't be below 0")
          .max(MAX_PEOPLE_IN_ROOM, `At most ${MAX_PEOPLE_IN_ROOM} in one room`),
      })
    )
    .max(500),
});

/** Keeps only the occupancy of rooms the mandal still has. */
export const occupancyFor = (roomIds: readonly string[], occupancy: MandalStay["occupancy"]) =>
  occupancy.filter(o => roomIds.includes(o.roomId));

export function toMandalStayDto(stay: MandalStay) {
  return {
    id: stay.id,
    placeId: stay.placeId,
    mandal: stay.mandal,
    coordinatorName: stay.coordinatorName,
    coordinatorMobile: stay.coordinatorMobile,
    notes: stay.notes ?? undefined,
    roomIds: stay.roomIds,
    occupancy: occupancyFor(stay.roomIds, stay.occupancy),
    occupancyUpdatedAt: stay.occupancyUpdatedAt?.toISOString(),
    occupancyUpdatedByName: stay.occupancyUpdatedByName ?? undefined,
    createdByName: stay.createdByName,
    updatedAt: stay.updatedAt.toISOString(),
  };
}
