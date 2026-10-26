import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Registration } from "@prisma/client";

import {
  GENDERS,
  MANDALS,
  MOBILE_E164,
  MAX_VEHICLES,
  MIN_FAMILY_CONTACT_AGE,
  OVERSEAS_MANDALS,
  RELATION_GENDER,
  REGISTRATION_STATUSES,
  statusOf,
  REGISTRATION_TYPES,
  ARRIVAL_DATES,
  DEPARTURE_DATES,
  SEVA_DATES,
  TIME_SLOTS,
  TRAIN_STATIONS,
  TRAVEL_MODES,
  PERSON_TRAVEL_MODES,
  JOURNEY_MODES,
  YOUTH_MAX_AGE,
  isJourneyMode,
  compareStay,
  isLocalMandal,
  isVehiclePlate,
  maxVehiclesFor,
  normalizePlate,
} from "./event";

/**
 * What `POST /registrations` accepts, and how a stored registration is sent
 * back.
 *
 * The body is the frontend's `NewRegistration` (the form's output after
 * `toNewRegistration`), so the rules here repeat the form's own. They are not
 * optional extras: the registration endpoint is public, and anything the form
 * would refuse has to be refused here too.
 */

// Any day a Swayam Sevak may pick. Whether a person may use the days outside
// the event's own is decided by their `earlySeva`, in superRefine.
const stayPoint = z.object({
  date: z.enum(SEVA_DATES, { error: "Pick a day in January or February 2027" }),
  slot: z.enum(TIME_SLOTS, { error: "Pick a time of day" }),
  // Whether they take the meal served then: breakfast, lunch or dinner.
  meal: z.boolean({ error: "Say whether you will take the meal" }),
});
const arrivalPoint = stayPoint;
const departurePoint = stayPoint;
const ARRIVAL_DAYS: readonly string[] = ARRIVAL_DATES;
const DEPARTURE_DAYS: readonly string[] = DEPARTURE_DATES;

const text = (max: number) => z.string().trim().max(max);

/**
 * Whether the text has letters from a script other than English's: a name
 * typed in Gujarati or Hindi. Names are kept in English letters only, so lists,
 * search, sorting and the printed reports read the same however the form was
 * filled in. Mirrors hasNonLatinLetters in the form (upasana-fe schema.ts).
 */
export const hasNonLatinLetters = (value: string) => /(?!\p{Script=Latin})\p{L}/u.test(value);
const ENGLISH_LETTERS = "Write the name in English letters";
const optionalText = (max: number) =>
  text(max)
    .optional()
    .nullable()
    .transform(v => (v ? v : null));

/** A flight into or out of Ahmedabad airport: the day, and the time and number if known. */
const indiaFlight = z
  .object({
    date: z.iso.date({ error: "Enter a valid date" }),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time like 06:30")
      .optional(),
    flight: text(20).optional(),
  })
  .optional();

/**
 * A pickup from Ahmedabad airport and the flight out, for devotees from
 * abroad. Both optional; a pickup needs its flight. No drop is arranged any
 * more, so `needsDrop` is stored false and the flight out is for the record.
 */
const indiaTravel = z
  .object({
    needsPickup: z.boolean(),
    arrival: indiaFlight,
    needsDrop: z.boolean(),
    departure: indiaFlight,
  })
  .refine(t => !t.needsPickup || t.arrival, {
    message: "Pick the day you land",
    path: ["arrival", "date"],
  })
  .optional();

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time like 06:30");

/**
 * How someone gets here and home again, without the vehicles: the mode, and
 * for a train, bus or flight the pickup and drop with their journeys. The
 * registration's `travel` is this plus the party's vehicles; a person's own
 * (`members[].travel`, when the party travels separately) is this alone.
 */
const journeyFields = {
  reference: optionalText(80),
  // Train, bus or flight, with a pickup: when it reaches Ahmedabad, and (train
  // only) at which station.
  arrivalTime: clockTime.optional(),
  station: z.enum(TRAIN_STATIONS, { error: "Pick a station from the list" }).optional(),
  needsPickup: z.boolean(),
  needsDrop: z
    .boolean()
    .optional()
    .transform(v => v ?? false),
  // With a drop: how they leave (not always how they came), the train or
  // bus home, its station (train only), and when it leaves.
  departureMode: z.enum(JOURNEY_MODES).optional(),
  departureReference: optionalText(80),
  departureStation: z.enum(TRAIN_STATIONS, { error: "Pick a station from the list" }).optional(),
  departureTime: clockTime.optional(),
};

/** A person's own travel: only the modes anyone can pick. */
const personTravel = z.object({
  mode: z.enum(PERSON_TRAVEL_MODES, { error: "Select how they are travelling" }),
  ...journeyFields,
});
type Journey = z.infer<typeof personTravel>;

/** One part of a person's name: in English letters, single-spaced. */
const namePart = (max: number) =>
  text(max)
    .refine(v => !hasNonLatinLetters(v), ENGLISH_LETTERS)
    .transform(v => v.replace(/\s+/g, " "));

type NameParts = { firstName: string; middleName?: string | null; surname: string };

/** "Ramesh Kantilal Patel": what is stored as `fullName`, and what every screen shows. */
export const fullNameOf = (name: NameParts) =>
  [name.firstName, name.middleName, name.surname]
    .map(part => (part ?? "").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" ");

/**
 * A one-line name split into first, middle and surname: the first word, the
 * last, and anything between. For people saved, or forms left open, from
 * before the name was asked in parts. Mirrors splitFullName in the form.
 */
export function splitFullName(fullName: string) {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { firstName: words[0] ?? "", middleName: null, surname: "" };
  return {
    firstName: words[0],
    middleName: words.slice(1, -1).join(" ") || null,
    surname: words[words.length - 1],
  };
}

/** A person as sent before the form asked for the name in parts: one `fullName`, split here. */
const withNameParts = (value: unknown) => {
  if (typeof value !== "object" || value === null) return value;
  const person = value as Record<string, unknown>;
  if (typeof person.fullName !== "string" || person.firstName !== undefined) return value;
  return { ...person, ...splitFullName(person.fullName) };
};

const member = z.preprocess(
  withNameParts,
  z.object({
    /** The person's id from an earlier save, when editing; empty for someone new. */
    id: z.string().max(40).optional(),
    firstName: namePart(60).pipe(z.string().min(1, "Enter the first name")),
    // Missing on an old one-line name of two words, split above.
    middleName: z.preprocess(
      v => v ?? "",
      namePart(60).pipe(z.string().min(1, "Enter the middle name"))
    ),
    surname: namePart(60).pipe(z.string().min(1, "Enter the surname")),
    gender: z.enum(GENDERS, { error: "Select a gender" }),
    age: z
      .number({ error: "Enter the age" })
      .int()
      .min(1, "Age must be 1 to 100")
      .max(100, "Age must be 1 to 100"),
    mobile: z
      .string()
      .regex(MOBILE_E164, "Enter a valid mobile number with country code")
      .optional()
      .nullable()
      .transform(v => v ?? null),
    relation: optionalText(40),
    isPrimary: z.boolean(),
    needsAssistance: z.boolean(),
    assistanceNote: optionalText(300),
    arrival: arrivalPoint,
    departure: departurePoint,
    /** Asks for a bed for this person. Absent: as `accommodationRequired` says for everyone. */
    needsAccommodation: z.boolean().optional(),
    /** Aged YOUTH_MAX_AGE or under: whether they will attend the Youth Convention. Optional. */
    attendsYouthConvention: z.boolean().optional(),
    /**
     * Arriving early for seva as a Swayam Sevak: this person may arrive and
     * leave on any day of January or February 2027 (SEVA_DATES), not only
     * around the event. Optional; absent is no.
     */
    earlySeva: z.boolean().optional(),
    /** Only when the registration's travel mode is "separate": how this person travels. */
    travel: personTravel.optional(),
    /**
     * From abroad, only when the party does not all land and fly out on the
     * same days: this person's airport pickup and flight out. Sent for anyone
     * in such a party, so its presence on any member is what splits it.
     */
    indiaTravel,
  })
);

export const newRegistrationSchema = z
  .object({
    type: z.enum(REGISTRATION_TYPES, { error: "Choose individual or family" }),
    groupName: optionalText(120),
    mandal: z.enum(MANDALS, { error: "Select a mandal from the list" }),
    // A cap well above any real party, so one request cannot store megabytes.
    members: z.array(member).min(1).max(100),
    arrival: arrivalPoint,
    departure: departurePoint,
    travel: z.object({
      mode: z.enum(TRAVEL_MODES, { error: "Select how you are travelling" }),
      vehicleCount: z
        .number()
        .int()
        .min(1)
        .max(MAX_VEHICLES.family)
        .optional()
        .nullable()
        .transform(v => v ?? null),
      // Optional, one per vehicle. Blank entries are dropped in toCreateData.
      vehicleNumbers: z
        .array(text(20))
        .max(MAX_VEHICLES.family)
        .optional()
        .transform(v => v ?? []),
      ...journeyFields,
    }),
    indiaTravel,
    accommodationRequired: z.boolean(),
    notes: optionalText(1000),
    /**
     * From POST /otp/verify: proof the primary contact's number was verified.
     * Checked and spent in registrationController, not stored. Optional here
     * because a sanchalak or admin may vouch in person instead
     * (`verifiedInPerson`), and an edit that keeps the number needs neither —
     * the controller decides which applies.
     */
    mobileVerificationToken: z.string().optional(),
    verifiedInPerson: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    if (value.type === "individual" && value.members.length !== 1) {
      issue(["members"], "An individual registration has exactly one person");
    }
    if (value.type !== "individual" && value.members.length < 2) {
      issue(["members"], "A family registration needs at least two people");
    }
    if (value.type !== "individual" && !value.groupName) {
      issue(["groupName"], "Enter the family name");
    } else if (value.groupName && hasNonLatinLetters(value.groupName)) {
      issue(["groupName"], ENGLISH_LETTERS);
    }
    if (!value.members[0]?.mobile) {
      issue(["members", 0, "mobile"], "The primary contact needs a mobile number");
    }
    if (compareStay(value.departure, value.arrival) <= 0) {
      issue(["departure"], "Departure has to be after arrival");
    }
    // A "Son" entered as female: one of the two fields is wrong.
    if (value.type === "family") {
      value.members.forEach((m, index) => {
        const expected = m.relation ? RELATION_GENDER[m.relation] : undefined;
        if (index > 0 && expected && m.gender !== expected) {
          issue(["members", index, "relation"], `${m.relation} has to be ${expected}`);
        }
      });
    }
    // The same person added twice — see the form's own rule: same name, gender
    // and age. Two people sharing a name (a father and son) differ in one of
    // the others. Names ignoring case and extra spaces.
    const seen = new Set<string>();
    value.members.forEach((m, index) => {
      const key = [fullNameOf(m).toLowerCase(), m.gender, m.age].join("|");
      if (seen.has(key)) issue(["members", index, "firstName"], "The same person is listed twice");
      seen.add(key);
    });
    value.members.forEach((m, index) => {
      if (compareStay(m.departure, m.arrival) <= 0) {
        issue(["members", index, "departure"], "Departure has to be after arrival");
      }
    });
    // Only a Swayam Sevak coming early may use the days outside the event's:
    // each person by their own answer, and the party's span (first in, last
    // out) unless someone in it is one.
    {
      const points = [
        ...value.members
          .map((m, index) => ({ path: ["members", index], ...m }))
          .filter(m => !m.earlySeva),
        ...(value.members.some(m => m.earlySeva)
          ? []
          : [{ path: [] as (string | number)[], arrival: value.arrival, departure: value.departure }]),
      ];
      for (const { path, arrival, departure } of points) {
        if (!ARRIVAL_DAYS.includes(arrival.date)) {
          issue([...path, "arrival", "date"], "Pick an arrival day between 28 January and 1 February");
        }
        if (!DEPARTURE_DAYS.includes(departure.date)) {
          issue([...path, "departure", "date"], "Pick a departure day between 28 January and 1 February");
        }
      }
    }
    // A family is looked after by an adult; someone registering alone may be younger.
    if (value.type === "family" && (value.members[0]?.age ?? 0) < MIN_FAMILY_CONTACT_AGE) {
      issue(
        ["members", 0, "age"],
        `A family's primary contact has to be ${MIN_FAMILY_CONTACT_AGE} or older`
      );
    }
    // "local" is set for nearby mandals, not chosen by anyone else.
    const local = isLocalMandal(value.mandal);
    if (
      value.travel.mode === "not_filled" ||
      (value.travel.mode === "local" && !local)
    ) {
      issue(["travel", "mode"], "Select how you are travelling");
    }
    // Travelling separately: a party of two or more, each with their own way.
    const separate = value.travel.mode === "separate";
    if (separate && (local || value.members.length < 2)) {
      issue(["travel", "mode"], "Select how you are travelling");
    }
    if (separate && !local) {
      value.members.forEach((m, index) => {
        if (!m.travel) issue(["members", index, "travel", "mode"], "Select how they are travelling");
        else checkJourney(m.travel, ["members", index, "travel"], issue);
      });
    } else if (!local) {
      checkJourney(value.travel, ["travel"], issue);
    }
    // The party's vehicles: no more than the people coming in them, at most four.
    const drivers = separate
      ? value.members.filter(m => m.travel?.mode === "personal_vehicle").length
      : value.travel.mode === "personal_vehicle"
        ? value.members.length
        : 0;
    if (drivers > 0) {
      const max = maxVehiclesFor(value.type, drivers);
      if ((value.travel.vehicleCount ?? 1) > max) {
        issue(
          ["travel", "vehicleCount"],
          value.type === "individual"
            ? "An individual registration has one vehicle"
            : `At most ${max} vehicles for ${drivers} people (and never more than ${MAX_VEHICLES.family})`
        );
      }
      const seenPlates = new Set<string>();
      value.travel.vehicleNumbers.forEach((plate, index) => {
        if (!plate) return;
        if (!isVehiclePlate(plate))
          issue(["travel", "vehicleNumbers", index], "Not a valid vehicle number");
        if (seenPlates.has(normalizePlate(plate)))
          issue(["travel", "vehicleNumbers", index], "The same vehicle is listed twice");
        seenPlates.add(normalizePlate(plate));
      });
    }
    // Landing in India before reaching the event, leaving after it ends —
    // each person by their own flights, or the party's when they share them.
    const ownFlights = value.members.some(m => m.indiaTravel);
    value.members.forEach((m, index) => {
      const path = ownFlights ? ["members", index, "indiaTravel"] : ["indiaTravel"];
      const flights = ownFlights ? m.indiaTravel : value.indiaTravel;
      const landing = flights?.needsPickup ? flights.arrival?.date : undefined;
      const leaving = flights?.departure?.date;
      if (landing && landing > m.arrival.date) {
        issue([...path, "arrival", "date"], "Has to be on or before you reach the event");
      }
      if (leaving && leaving < m.departure.date) {
        issue([...path, "departure", "date"], "Has to be on or after you leave the event");
      }
    });
    if (value.travel.vehicleNumbers.length > (value.travel.vehicleCount ?? 1)) {
      issue(["travel", "vehicleNumbers"], "More vehicle numbers than vehicles");
    }
  });

export type NewRegistrationInput = z.infer<typeof newRegistrationSchema>;

/**
 * A pickup or drop by train, bus or flight needs its journey: the train's
 * number, station and time, the bus's details and time, or the flight number
 * and time. For the party's travel or one person's, at `path`.
 */
function checkJourney(
  t: Omit<Journey, "mode"> & { mode: string },
  path: (string | number)[],
  issue: (path: (string | number)[], message: string) => void
) {
  if (!isJourneyMode(t.mode)) return;
  if (t.needsPickup && t.needsDrop && !t.departureMode) {
    issue([...path, "departureMode"], "Select how you are leaving");
  }
  const legs = [
    {
      wanted: t.needsPickup,
      mode: t.mode,
      reference: "reference",
      station: "station",
      time: "arrivalTime",
    },
    {
      wanted: t.needsPickup && t.needsDrop && !!t.departureMode,
      mode: t.departureMode,
      reference: "departureReference",
      station: "departureStation",
      time: "departureTime",
    },
  ] as const;
  for (const leg of legs) {
    if (!leg.wanted) continue;
    const train = leg.mode === "train";
    if (!t[leg.reference]?.trim()) {
      issue(
        [...path, leg.reference],
        train
          ? "Enter the train number and name"
          : leg.mode === "flight"
            ? "Enter the flight number"
            : "Enter the bus details"
      );
    }
    if (train && !t[leg.station]) issue([...path, leg.station], "Pick the station");
    if (!t[leg.time]) issue([...path, leg.time], "Pick the time");
  }
}

export const statusSchema = z.object({
  status: z.enum(REGISTRATION_STATUSES, { error: "Unknown status" }),
});

/**
 * Member ids for a save. An id the registration already had is kept — room
 * allotments point at it, so removing person 2 must not hand their bed to
 * person 3. Anything else (someone new, or an id the client made up or sent
 * twice) gets a fresh one.
 */
function memberIds(input: NewRegistrationInput, existingIds: readonly string[]) {
  const known = new Set(existingIds);
  const used = new Set<string>();
  return input.members.map(m => {
    if (m.id && known.has(m.id) && !used.has(m.id)) {
      used.add(m.id);
      return m.id;
    }
    let id: string;
    do id = `m${randomBytes(4).toString("hex")}`;
    while (known.has(id) || used.has(id));
    used.add(id);
    return id;
  });
}

/**
 * The stored values, normalised before they are written. Primary flags are
 * not trusted: the first member is the primary contact, by the form's
 * definition. `existingIds` are the members' ids before an edit.
 */
export function toCreateData(input: NewRegistrationInput, existingIds: readonly string[] = []) {
  const ids = memberIds(input, existingIds);
  // From abroad, the party may not all land and fly out on the same days.
  const overseas = OVERSEAS_MANDALS.includes(input.mandal);
  const ownFlights = overseas && input.members.some(m => m.indiaTravel);
  // A nearby mandal travels from home and sleeps there: no travel, no beds.
  const local = isLocalMandal(input.mandal);
  // Each person's own travel is kept only while the party travels separately.
  const separate = !local && input.travel.mode === "separate";
  const members = input.members.map((m, index) => ({
    ...m,
    id: ids[index],
    fullName: fullNameOf(m),
    isPrimary: index === 0,
    relation: input.type === "family" && index > 0 ? m.relation : null,
    assistanceNote: m.needsAssistance ? m.assistanceNote : null,
    attendsYouthConvention: m.age <= YOUTH_MAX_AGE ? (m.attendsYouthConvention ?? null) : null,
    earlySeva: m.earlySeva ?? false,
    // Someone who leaves the day they arrive has no night here, so no bed.
    needsAccommodation:
      !local &&
      (m.needsAccommodation ?? input.accommodationRequired) &&
      m.departure.date > m.arrival.date,
    travel: separate && m.travel ? { ...journeyRecord(m.travel), vehicleCount: null, vehicleNumbers: [] } : null,
    indiaTravel: ownFlights ? indiaTravelRecord(m.indiaTravel) : null,
  }));
  const drivers = separate
    ? members.filter(m => m.travel?.mode === "personal_vehicle").length
    : input.travel.mode === "personal_vehicle"
      ? members.length
      : 0;
  const vehicles = {
    vehicleCount: drivers > 0 ? (input.travel.vehicleCount ?? 1) : null,
    vehicleNumbers:
      drivers > 0 ? input.travel.vehicleNumbers.filter(Boolean).map(n => n.toUpperCase()) : [],
  };

  return {
    // One registration per contact number; the unique index is on this.
    contactMobile: input.members[0]?.mobile ?? null,
    type: input.type,
    groupName: input.type === "individual" ? null : input.groupName,
    mandal: input.mandal,
    members,
    arrival: input.arrival,
    departure: input.departure,
    travel: local
      ? {
          mode: "local",
          vehicleCount: null,
          vehicleNumbers: [],
          reference: null,
          arrivalTime: null,
          station: null,
          needsPickup: false,
          needsDrop: false,
          departureMode: null,
          departureReference: null,
          departureStation: null,
          departureTime: null,
        }
      : separate
        ? {
            // The party's travel only says that it is split, which vehicles
            // come, and whether anyone at all needs a pickup or a drop.
            mode: "separate",
            ...vehicles,
            reference: null,
            arrivalTime: null,
            station: null,
            needsPickup: members.some(m => m.travel?.needsPickup),
            needsDrop: members.some(m => m.travel?.needsDrop),
            departureMode: null,
            departureReference: null,
            departureStation: null,
            departureTime: null,
          }
        : { ...journeyRecord(input.travel), ...vehicles },
    // True when anyone in the party has a bed coming; each person's own
    // answer is on them.
    accommodationRequired: members.some(m => m.needsAccommodation),
    // True when anyone is; each person's own answer is on them.
    earlySeva: members.some(m => m.earlySeva),
    // Split: only whether anyone needs a pickup; the flights are on each person.
    indiaTravel: !overseas
      ? null
      : ownFlights
        ? members.some(m => m.indiaTravel)
          ? {
              needsPickup: members.some(m => m.indiaTravel?.needsPickup),
              arrival: null,
              needsDrop: false,
              departure: null,
            }
          : null
        : indiaTravelRecord(input.indiaTravel),
    notes: input.notes,
  };
}

/**
 * A journey as stored: the arrival time and station only where they apply, a
 * pickup only by train, bus or flight, and a drop only with a pickup.
 */
function journeyRecord(travel: Omit<Journey, "mode"> & { mode: string }) {
  const pickup = isJourneyMode(travel.mode) && travel.needsPickup;
  return {
    mode: travel.mode,
    reference: travel.reference,
    arrivalTime: (isJourneyMode(travel.mode) && travel.arrivalTime) || null,
    station: (travel.mode === "train" && travel.station) || null,
    needsPickup: pickup,
    needsDrop: pickup && travel.needsDrop,
    ...journeyHome(travel),
  };
}

/**
 * How they leave and the train or bus home, kept only with a drop; a station
 * only when leaving by train.
 */
function journeyHome(travel: Omit<Journey, "mode"> & { mode: string }) {
  const kept =
    isJourneyMode(travel.mode) && travel.needsPickup && travel.needsDrop && !!travel.departureMode;
  return {
    departureMode: (kept && travel.departureMode) || null,
    departureReference: (kept && travel.departureReference) || null,
    departureStation: (kept && travel.departureMode === "train" && travel.departureStation) || null,
    departureTime: (kept && travel.departureTime) || null,
  };
}

/**
 * The Ahmedabad airport pickup and flight out as stored, the party's or one
 * person's: only when a pickup was asked for or the flight out given.
 */
function indiaTravelRecord(india: NewRegistrationInput["indiaTravel"]) {
  if (!india) return null;
  if (!india.needsPickup && !india.departure) return null;
  type Leg = NonNullable<typeof india.arrival>;
  const leg = (f?: Leg) =>
    f
      ? { date: f.date, time: f.time || null, flight: f.flight ? f.flight.toUpperCase() : null }
      : null;
  return {
    needsPickup: india.needsPickup,
    arrival: india.needsPickup ? leg(india.arrival) : null,
    needsDrop: false,
    departure: leg(india.departure),
  };
}

/** Stored airport flights in the shape the frontend reads. */
function indiaTravelDto(india: NonNullable<Registration["indiaTravel"]>) {
  return {
    ...india,
    arrival: india.arrival ? compact({ ...india.arrival }) : undefined,
    departure: india.departure ? compact({ ...india.departure }) : undefined,
  };
}

/** Drops nulls, so optional fields arrive absent as the frontend's types expect. */
function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as {
    [K in keyof T]: Exclude<T[K], null> | undefined;
  };
}

/**
 * Whether this person asked for a bed. Registrations from before the
 * per-person answer existed only have the registration's, which then covered
 * everyone.
 */
export function wantsBed(
  registration: Pick<Registration, "accommodationRequired">,
  member: { needsAccommodation?: boolean | null }
) {
  return registration.accommodationRequired && (member.needsAccommodation ?? true);
}

/**
 * Whether this person is arriving early for seva as a Swayam Sevak. It was
 * first asked once for the whole party; registrations saved then have no
 * answer per person, and the registration's covers everyone.
 */
export function isSevak(
  registration: Pick<Registration, "earlySeva">,
  member: { earlySeva?: boolean | null }
) {
  return member.earlySeva ?? registration.earlySeva === true;
}

/** A stored registration in the shape the frontend reads. Internal fields stay behind. */
export function toRegistrationDto(r: Registration) {
  return compact({
    id: r.id,
    code: r.code,
    type: r.type,
    groupName: r.groupName,
    mandal: r.mandal,
    members: r.members.map(m =>
      compact({
        ...m,
        // Saved before the name was asked in parts: split, for the form to edit.
        ...(m.firstName ? {} : splitFullName(m.fullName)),
        arrival: compact({ ...m.arrival }),
        departure: compact({ ...m.departure }),
        needsAccommodation: wantsBed(r, m),
        earlySeva: isSevak(r, m),
        travel: m.travel ? compact({ ...m.travel }) : null,
        indiaTravel: m.indiaTravel ? indiaTravelDto(m.indiaTravel) : null,
      })
    ),
    arrival: compact({ ...r.arrival }),
    departure: compact({ ...r.departure }),
    travel: compact({ ...r.travel }),
    indiaTravel: r.indiaTravel && indiaTravelDto(r.indiaTravel),
    accommodationRequired: r.accommodationRequired,
    // Always a boolean, so an old row (null) and an unticked save read the
    // same and editing one does not log a change nobody made.
    earlySeva: r.earlySeva === true,
    notes: r.notes,
    status: statusOf(r.status),
    source: r.source,
    isSample: r.isSample,
    createdAt: r.createdAt.toISOString(),
    mobileVerification: r.mobileVerification,
    verifiedByName: r.verifiedByName,
    editedAt: r.editedAt?.toISOString() ?? null,
    editedByName: r.editedByName,
  });
}

/**
 * Just enough to recognise a registration — for "this number already has a
 * registration" warnings. `id` only when the viewer may open it.
 */
export function toRegistrationSummary(r: Registration, canOpen: boolean) {
  return {
    id: canOpen ? r.id : undefined,
    code: r.code,
    name: r.groupName ?? r.members[0]?.fullName ?? "",
    people: r.members.length,
    status: statusOf(r.status),
    mandal: r.mandal,
  };
}
