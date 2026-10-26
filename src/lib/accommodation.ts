import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AccommodationPlace, Registration, RoomAllotment } from "@prisma/client";

import { EVENT_NAME, MOBILE_E164, NIGHTS, formatDay } from "./event";
import { wantsBed } from "./registrations";

/**
 * Where devotees stay: places (guest houses, later hotels) with rooms, and one
 * allotment per person.
 *
 * PAUSED 2026-10-11: per-person allotment (the room rules, notices) is
 * switched off — rooms now go to mandals, see src/lib/mandal-stays.ts. The
 * place and room schemas here are still live.
 *
 * A person's nights come from their own arrival and departure, so a bed freed
 * after the first night can go to someone arriving for the second. The rules
 * for who may share a room (`roomProblem`) are mirrored in the frontend's
 * src/features/accommodation/rules.ts, which uses them to show which rooms
 * fit before anyone presses Save; the server checks them again on every
 * allotment.
 */

export const PLACE_KINDS = ["guest_house", "hotel"] as const;

/** Floors a room can be on: 0 is the ground floor, up to the 4th. */
export const MAX_FLOOR = 4;
export const ROOM_KINDS = ["gents", "ladies", "family", "general"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/**
 * Registrations whose people can be given a room: all but cancelled ones,
 * whose beds are released. "pending" is the old name for "confirmed"
 * (statusOf in ./event), kept until every registration is moved over.
 */
export const ALLOTTABLE_STATUSES = new Set(["pending", "confirmed", "checked_in"]);

type Stay = { arrival: { date: string }; departure: { date: string } };

/** The nights someone sleeps over: from their arrival day up to, not including, the day they leave. */
export function nightsOf(member: Stay): string[] {
  return NIGHTS.filter(night => night >= member.arrival.date && night < member.departure.date);
}

/**
 * Children younger than this share a parent's bed: they are given a room, so
 * everyone knows where they sleep, but take no bed of their own.
 */
export const SHARES_BED_UNDER = 5;

/**
 * Children younger than this may sleep in a gents or ladies room of the other
 * gender, with a parent or relative from their own registration — a young boy
 * with his mother when a family is split by gender.
 */
export const WITH_PARENT_UNDER = 12;

/** Who counts as the grown-up a child stays with. */
const ADULT_AGE = 18;

/** Whether someone takes a bed of their own. */
export const takesBed = (member: { age: number }) => member.age >= SHARES_BED_UNDER;

/** Someone in a room, as the room rules see them. */
export type Occupant = {
  registrationId: string;
  memberId: string;
  fullName: string;
  gender: string;
  age: number;
  nights: string[];
  /**
   * The team let them share a family room with another registration (their
   * relatives, registered separately). They do not count as "another family"
   * in it.
   */
  shared: boolean;
};

type RoomRules = { label: string; beds: number; extraBeds?: number | null; kind: string };

/** Beds plus extra mattresses: the most people a room can sleep in a night. */
export const capacityOf = (room: RoomRules) => room.beds + (room.extraBeds ?? 0);

export type RoomIssue = {
  /** "family" is the one the team may override, by letting relatives share. */
  kind: "gender" | "family" | "child" | "beds";
  message: string;
};

/**
 * What is wrong with these people sharing this room, or null when nothing is.
 *
 * - Gents and ladies rooms take only men or only women — except children
 *   under 12 staying with a grown-up from their own registration.
 * - A family room takes one registration's people a night, of any gender;
 *   another family may have it on other nights, and relatives the team let
 *   share do not count as another family.
 * - A general room takes anyone: only its beds limit it.
 * - A child under 5 shares a parent's bed, so needs a grown-up from their
 *   registration in the room, and takes no bed.
 * - On no night are there more bed-takers than beds and extra mattresses.
 *
 * Agreed for now and expected to be revisited; keep them here, in one place.
 * Mirrored in the frontend's src/features/accommodation/rules.ts.
 */
export function roomIssue(room: RoomRules, occupants: Occupant[]): RoomIssue | null {
  /** A grown-up from their own registration in the room on every night they are. */
  const accompanied = (child: Occupant) =>
    child.nights.every(night =>
      occupants.some(
        o =>
          o.registrationId === child.registrationId &&
          o.memberId !== child.memberId &&
          o.age >= ADULT_AGE &&
          o.nights.includes(night)
      )
    );

  const wrongGender = room.kind === "gents" ? "female" : room.kind === "ladies" ? "male" : undefined;
  if (wrongGender) {
    const out = occupants.find(
      o => o.gender === wrongGender && !(o.age < WITH_PARENT_UNDER && accompanied(o))
    );
    if (out) {
      return {
        kind: "gender",
        message:
          out.age < WITH_PARENT_UNDER
            ? `Room ${room.label} is a ${room.kind} room — ${out.fullName} (${out.age}) can stay in it only with a grown-up from their family`
            : `Room ${room.label} is a ${room.kind} room — ${out.fullName} is ${out.gender}`,
      };
    }
  }
  const baby = occupants.find(o => !takesBed(o) && !accompanied(o));
  if (baby) {
    return {
      kind: "child",
      message: `${baby.fullName} (${baby.age}) shares a parent's bed, so needs a grown-up from their family in Room ${room.label}`,
    };
  }
  for (const night of NIGHTS) {
    const there = occupants.filter(o => o.nights.includes(night));
    // One family a night: another family may have it on other nights, and
    // relatives the team let share are not "another family".
    if (room.kind === "family" && new Set(there.filter(o => !o.shared).map(o => o.registrationId)).size > 1) {
      return {
        kind: "family",
        message: `Room ${room.label} is a family room — another family has it on the night of ${formatDay(night)}`,
      };
    }
    const sleepers = there.filter(takesBed).length;
    if (sleepers > capacityOf(room)) {
      const extra = room.extraBeds ? ` and ${room.extraBeds} extra` : "";
      return {
        kind: "beds",
        message: `Room ${room.label} has ${room.beds} ${room.beds === 1 ? "bed" : "beds"}${extra} but ${sleepers} people need one on the night of ${formatDay(night)}`,
      };
    }
  }
  return null;
}

export const roomProblem = (room: RoomRules, occupants: Occupant[]) =>
  roomIssue(room, occupants)?.message ?? null;

/** The people in `allotments` who still exist on their registration, ready for `roomProblem`. */
export function occupantsOf(
  allotments: RoomAllotment[],
  registrations: Map<string, Registration>
): Occupant[] {
  return allotments.flatMap(a => {
    const member = registrations.get(a.registrationId)?.members.find(m => m.id === a.memberId);
    return member
      ? [
          {
            registrationId: a.registrationId,
            memberId: a.memberId,
            fullName: member.fullName,
            gender: member.gender,
            age: member.age,
            nights: nightsOf(member),
            shared: a.sharesRoom,
          },
        ]
      : [];
  });
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform(v => (v ? v : null));

const roomInput = z.object({
  /** Kept from an earlier save; empty for a new room. */
  id: z.string().max(40).optional(),
  label: z
    .string()
    .trim()
    .min(1, "Give the room a number or name")
    .max(30, "Keep the room name short"),
  beds: z
    .number({ error: "Enter the beds" })
    .int()
    .min(1, "At least 1 bed")
    .max(50, "At most 50 beds"),
  /** Mattresses the room can take on top of its beds, used only when the beds run out. */
  extraBeds: z
    .number()
    .int()
    .min(0)
    .max(20, "At most 20 extra mattresses")
    .optional()
    .transform(v => v ?? 0),
  kind: z.enum(ROOM_KINDS, { error: "Pick gents, ladies, family or general" }),
  /** 0 = ground floor, 1 = 1st floor … 4 = 4th floor. */
  floor: z
    .number({ error: "Pick the floor" })
    .int()
    .min(0, "Pick the floor")
    .max(MAX_FLOOR, "Pick the floor"),
});

export const placeInputSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the place's name").max(120),
    kind: z.enum(PLACE_KINDS, { error: "Pick guest house or hotel" }),
    address: z.string().trim().min(3, "Enter the address").max(300),
    area: optionalText(80),
    mapUrl: optionalText(500).refine(
      v => !v || /^https:\/\/\S+$/.test(v),
      "Paste a link starting with https://"
    ),
    coordinatorName: optionalText(120),
    coordinatorMobile: z
      .string()
      .regex(MOBILE_E164, "Enter a valid mobile number")
      .optional()
      .nullable()
      .transform(v => v ?? null),
    notes: optionalText(1000),
    rooms: z.array(roomInput).max(500, "At most 500 rooms in one place"),
  })
  .superRefine((value, ctx) => {
    const seen = new Map<string, number>();
    value.rooms.forEach((room, index) => {
      const key = room.label.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["rooms", index, "label"],
          message: `Room ${room.label} is listed twice`,
        });
      }
      seen.set(key, index);
    });
  });

export type PlaceInput = z.infer<typeof placeInputSchema>;

/**
 * Room ids for a save: an id the place already had is kept (allotments point
 * at it, so renaming room "12" to "G-12" keeps its people); anything else
 * gets a new one.
 */
export function withRoomIds(rooms: PlaceInput["rooms"], existingIds: readonly string[] = []) {
  const known = new Set(existingIds);
  const used = new Set<string>();
  return rooms.map(({ id, ...room }) => {
    if (id && known.has(id) && !used.has(id)) {
      used.add(id);
      return { ...room, id };
    }
    let fresh: string;
    do fresh = `r${randomBytes(4).toString("hex")}`;
    while (known.has(fresh) || used.has(fresh));
    used.add(fresh);
    return { ...room, id: fresh };
  });
}

/** Drops nulls, so optional fields arrive absent as the frontend's types expect. */
function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as {
    [K in keyof T]: Exclude<T[K], null> | undefined;
  };
}

export function toPlaceDto(place: AccommodationPlace) {
  return compact({
    id: place.id,
    name: place.name,
    kind: place.kind,
    address: place.address,
    area: place.area,
    mapUrl: place.mapUrl,
    coordinatorName: place.coordinatorName,
    coordinatorMobile: place.coordinatorMobile,
    notes: place.notes,
    sortOrder: place.sortOrder,
    rooms: place.rooms,
  });
}

export function toAllotmentDto(a: RoomAllotment) {
  return {
    id: a.id,
    registrationId: a.registrationId,
    memberId: a.memberId,
    placeId: a.placeId,
    roomId: a.roomId,
    sharesRoom: a.sharesRoom,
    allottedByName: a.allottedByName,
    allottedAt: a.allottedAt.toISOString(),
  };
}

/**
 * Where a registration's people stay, as told to them: by place, then room.
 * Built the same way every time, so comparing a fresh one with the one stored
 * when it was sent says whether anything changed since.
 */
export type StayNotice = {
  places: {
    name: string;
    address: string;
    area?: string;
    mapUrl?: string;
    coordinatorName?: string;
    coordinatorMobile?: string;
    rooms: { label: string; people: string[] }[];
  }[];
};

const byLabel = new Intl.Collator("en", { numeric: true }).compare;

/** Null when nobody in the registration has a room. */
export function buildStayNotice(
  registration: Registration,
  allotments: RoomAllotment[],
  places: Map<string, AccommodationPlace>
): StayNotice | null {
  const mine = allotments.filter(a => a.registrationId === registration.id);
  const used = [...new Set(mine.map(a => a.placeId))]
    .map(id => places.get(id))
    .filter((p): p is AccommodationPlace => !!p)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const result: StayNotice["places"] = used.map(place => {
    const here = mine.filter(a => a.placeId === place.id);
    const rooms = place.rooms
      .filter(room => here.some(a => a.roomId === room.id))
      .sort((a, b) => byLabel(a.label, b.label))
      .map(room => ({
        label: room.label,
        // In the order the registration lists them: the contact first.
        people: registration.members
          .filter(m => here.some(a => a.roomId === room.id && a.memberId === m.id))
          .map(m => m.fullName),
      }))
      .filter(room => room.people.length > 0);
    return {
      name: place.name,
      address: place.address,
      ...(place.area ? { area: place.area } : {}),
      ...(place.mapUrl ? { mapUrl: place.mapUrl } : {}),
      ...(place.coordinatorName ? { coordinatorName: place.coordinatorName } : {}),
      ...(place.coordinatorMobile ? { coordinatorMobile: place.coordinatorMobile } : {}),
      rooms,
    };
  });
  const withPeople = result.filter(p => p.rooms.length > 0);
  return withPeople.length > 0 ? { places: withPeople } : null;
}

/** Whether two notices say the same thing. */
export const sameNotice = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** "+91 98765 43210" */
const formatMobile = (e164: string) => {
  const match = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return match ? `+91 ${match[1]} ${match[2]}` : e164;
};

/** One place: where it is, who is in which room, and how to get there and whom to call. */
function placeParts(place: StayNotice["places"][number]) {
  const extras: string[] = [];
  if (place.mapUrl) extras.push(`Map: ${place.mapUrl}`);
  if (place.coordinatorName || place.coordinatorMobile) {
    extras.push(
      `Contact: ${[place.coordinatorName, place.coordinatorMobile && formatMobile(place.coordinatorMobile)].filter(Boolean).join(", ")}`
    );
  }
  return {
    heading: `${place.name}, ${place.address}`,
    rooms: place.rooms.map(r => `Room ${r.label}: ${r.people.join(", ")}`),
    extras,
  };
}

/**
 * The details as one line, for the WhatsApp template's `{{3}}`: Meta refuses
 * a placeholder value with line breaks, tabs or long runs of spaces, and caps
 * the body's length.
 */
export function stayNoticeLine(notice: StayNotice) {
  const line = notice.places
    .map(p => {
      const { heading, rooms, extras } = placeParts(p);
      return [heading, rooms.join("; "), ...extras].join(". ");
    })
    .join(" | ");
  return line.length > 900 ? `${line.slice(0, 897)}…` : line;
}

/** The whole message as a person would type it, for sending from a team member's own WhatsApp. */
export function stayNoticeMessage(registration: Registration, notice: StayNotice) {
  const name = registration.members[0]?.fullName ?? "";
  const blocks = notice.places.map(p => {
    const { heading, rooms, extras } = placeParts(p);
    return [heading, ...rooms, ...extras].join("\n");
  });
  return [
    `Hello ${name}, your stay for ${EVENT_NAME} is arranged.`,
    ...blocks,
    "Please show this message at the guest house.",
  ].join("\n\n");
}

/**
 * Whether everyone in the registration who asked for a bed and sleeps over
 * has a room. Someone leaving the day they arrive needs none.
 */
export function fullyAllotted(registration: Registration, allotments: RoomAllotment[]) {
  return registration.members
    .filter(m => wantsBed(registration, m) && nightsOf(m).length > 0)
    .every(m => allotments.some(a => a.registrationId === registration.id && a.memberId === m.id));
}
