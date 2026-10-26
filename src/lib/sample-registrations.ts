/**
 * The 64 made-up registrations used for demos, and adding or removing them.
 *
 * Generated from a fixed seed: the same bookings every time. None of these
 * people are real; the names are common Gujarati names picked at random.
 * They take sequences 1–64, are numbered "DMS-" (DMS-0101 for the first
 * person, DMS-F-0101 for the first family) rather than "DM-", and are flagged
 * `isSample`, so removing them can never touch a real registration.
 *
 * Used by the admin toggle (adminSampleDataController) and by
 * `pnpm seed:registrations`.
 *
 * Each sample is built as the form would send it and saved through the same
 * check and shaping as a real registration (`newRegistrationSchema`,
 * `toCreateData`), so samples follow every rule the form does — and a rule
 * they break fails the save, and sample-registrations.test.ts, loudly.
 */
import {
  EVENT_DAYS,
  MANDALS,
  OVERSEAS_MANDALS,
  TRAIN_STATIONS,
  YOUTH_MAX_AGE,
  formatFamilyCode,
  formatPersonCode,
  isLocalMandal,
  type StayPoint,
} from "./event";
import { newRegistrationSchema, toCreateData } from "./registrations";
import { prisma } from "../utils/db";

type Gender = "male" | "female";
type Member = {
  id: string;
  firstName: string;
  /** The father's (or husband's) name, as Gujarati names go. */
  middleName: string;
  surname: string;
  gender: Gender;
  age: number;
  mobile?: string;
  relation?: string;
  isPrimary: boolean;
  needsAssistance: boolean;
  assistanceNote?: string;
  arrival: StayPoint;
  departure: StayPoint;
  needsAccommodation?: boolean;
  attendsYouthConvention?: boolean;
};
type SeedFlight = { date: string; time: string; flight: string };
type SeedRegistration = {
  sequence: number;
  code: string;
  /** Each person's number, in `members` order. */
  memberCodes: string[];
  type: string;
  groupName?: string;
  mandal: string;
  members: Member[];
  arrival: StayPoint;
  departure: StayPoint;
  travel: {
    mode: string;
    vehicleCount?: number;
    vehicleNumbers: string[];
    reference?: string;
    arrivalTime?: string;
    station?: string;
    needsPickup: boolean;
    needsDrop?: boolean;
    departureMode?: string;
    departureReference?: string;
    departureStation?: string;
    departureTime?: string;
  };
  indiaTravel?: {
    needsPickup: boolean;
    arrival?: SeedFlight;
    needsDrop: boolean;
    departure?: SeedFlight;
  };
  accommodationRequired: boolean;
  notes?: string;
  status: string;
  source: string;
  /** "otp", or "in_person" when someone at the desk vouched (`verifiedByName`). */
  mobileVerification: string;
  verifiedByName?: string;
  createdAt: string;
};
type RegistrationType = string;
type RegistrationStatus = string;
type TravelMode = string;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MALE_NAMES = [
  "Hitesh",
  "Jignesh",
  "Bhavesh",
  "Nilesh",
  "Ketan",
  "Paresh",
  "Mahesh",
  "Rakesh",
  "Dhruv",
  "Harsh",
  "Parth",
  "Yash",
  "Krunal",
  "Chirag",
  "Vipul",
  "Hardik",
  "Darshan",
  "Nirav",
  "Tirth",
  "Meet",
  "Jay",
  "Smit",
  "Kishan",
  "Ramesh",
  "Dilip",
  "Pravin",
  "Haresh",
  "Anil",
];
const FEMALE_NAMES = [
  "Bhavna",
  "Hetal",
  "Komal",
  "Nirali",
  "Priya",
  "Riddhi",
  "Jinal",
  "Kinjal",
  "Dhara",
  "Falguni",
  "Pooja",
  "Mansi",
  "Krupa",
  "Urvashi",
  "Khushi",
  "Shreya",
  "Disha",
  "Vidhi",
  "Hiral",
  "Ila",
  "Sarla",
  "Manjula",
  "Jaya",
  "Kokila",
];
const SURNAMES = [
  "Patel",
  "Shah",
  "Mehta",
  "Desai",
  "Joshi",
  "Trivedi",
  "Bhatt",
  "Panchal",
  "Parmar",
  "Chauhan",
  "Thakkar",
  "Modi",
  "Vyas",
  "Pandya",
  "Soni",
  "Gajjar",
  "Raval",
  "Dave",
  "Prajapati",
  "Solanki",
];

const PLATE_PREFIX: Record<string, string> = {
  Ahmedabad: "GJ-01",
  Gandhinagar: "GJ-18",
  Surat: "GJ-05",
  Baroda: "GJ-06",
  Rajkot: "GJ-03",
  Bhavnagar: "GJ-04",
  Anand: "GJ-23",
  Mumbai: "MH-02",
  Pune: "MH-12",
  Delhi: "DL-3C",
};

const TRAINS = [
  "12009 Shatabdi Exp",
  "12901 Gujarat Mail",
  "19015 Saurashtra Exp",
  "12957 Rajdhani Exp",
  "22953 Gujarat Exp",
  "12933 Karnavati Exp",
];

const BUSES = [
  "GSRTC Volvo",
  "GSRTC Express",
  "Shrinath Travels sleeper",
  "Patel Travels",
  "Eagle Travels",
];

/** The team at the desk, for registrations verified in person. Made up. */
const DESK_NAMES = ["Nilesh Joshi", "Hetal Mehta", "Bhavesh Raval"];

const ABROAD = new Set(OVERSEAS_MANDALS);

/** "2027-01-29" moved by `days`. */
function shiftDate(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildSampleRegistrations(): SeedRegistration[] {
  const rand = mulberry32(20261225);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const chance = (p: number) => rand() < p;
  const mobile = (mandal: string) =>
    mandal === "UK"
      ? `+447${between(100000000, 999999999)}`
      : mandal === "USA" || mandal === "Canada"
        ? `+1${between(201, 989)}${between(1000000, 9999999)}`
        : mandal === "Australia"
          ? `+614${between(10000000, 99999999)}`
          : mandal === "New Zealand"
            ? `+6421${between(1000000, 9999999)}`
            : mandal === "Dubai"
              ? `+9715${between(10000000, 99999999)}`
              : `+919${between(100000000, 999999999)}`;

  // One registration per contact number, so no two samples share one.
  const usedContacts = new Set<string>();
  const contactMobile = (mandal: string) => {
    let number = mobile(mandal);
    while (usedContacts.has(number)) number = mobile(mandal);
    usedContacts.add(number);
    return number;
  };

  /** "HH:MM" inside a slot, so a morning arrival comes on a morning train. */
  const timeIn = (slot: string) => {
    const [from, to] = slot === "morning" ? [6, 11] : slot === "afternoon" ? [12, 15] : [16, 22];
    return `${String(between(from, to)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}`;
  };

  // The first names already used in the registration being built: nobody is
  // listed twice.
  let usedNames = new Set<string>();
  const nameFor = (gender: Gender) => {
    const names = (gender === "male" ? MALE_NAMES : FEMALE_NAMES).filter(n => !usedNames.has(n));
    const name = pick(names);
    usedNames.add(name);
    return name;
  };

  // Most people take the meal served as they arrive or before they leave.
  const stay = (date: string, slot: string): StayPoint => ({
    date,
    slot,
    meal: chance(0.85),
  });

  /** Most people come for the whole event; some come late or leave early. */
  const pickSchedule = (abroad: boolean): [StayPoint, StayPoint] => {
    const roll = rand();
    if (abroad || roll < 0.35) {
      return [
        stay(EVENT_DAYS[0], "evening"),
        stay(EVENT_DAYS[EVENT_DAYS.length - 1], pick(["morning", "afternoon"] as const)),
      ];
    }
    if (roll < 0.7) {
      return [
        stay(EVENT_DAYS[0], pick(["morning", "afternoon"] as const)),
        stay(EVENT_DAYS[EVENT_DAYS.length - 1], "evening"),
      ];
    }
    // Event days only: comes late, leaves early, or both.
    // Indices into EVENT_DAYS: arrive on day 2 to the second-last day, leave
    // a later day up to the last. (Leaving one past the last day once meant
    // the day after the event; with event days only it is no day at all.)
    const startIndex = between(1, EVENT_DAYS.length - 2);
    const endIndex = between(startIndex + 1, EVENT_DAYS.length - 1);
    return [stay(EVENT_DAYS[startIndex], "morning"), stay(EVENT_DAYS[endIndex], "evening")];
  };

  // The mandal of the registration being built, for the mobile's country code.
  let currentMandal = "";

  const makeMember = (
    index: number,
    fields: Pick<Member, "firstName" | "surname" | "gender" | "age"> &
      Partial<Pick<Member, "relation" | "isPrimary">>,
    schedule: [StayPoint, StayPoint]
  ): Member => {
    const senior = fields.age >= 68;
    const needsAssistance = senior ? chance(0.6) : chance(0.03);
    return {
      id: `m${index}`,
      isPrimary: false,
      middleName: pick(MALE_NAMES),
      ...fields,
      mobile: fields.isPrimary
        ? contactMobile(currentMandal)
        : chance(0.4)
          ? mobile(currentMandal)
          : undefined,
      needsAssistance,
      assistanceNote: needsAssistance
        ? senior
          ? pick([
              "Ground-floor room please",
              "Walks with a stick",
              "Diabetic, needs sugar-free meals",
            ])
          : pick(["Wheelchair user", "Asthma, carries inhaler"])
        : undefined,
      arrival: schedule[0],
      departure: schedule[1],
      // Asked of everyone 40 and under; a few skip it, as it is optional.
      ...(fields.age <= YOUTH_MAX_AGE && chance(0.85)
        ? { attendsYouthConvention: chance(0.6) }
        : {}),
    };
  };

  const registrations: SeedRegistration[] = [];

  for (let i = 0; i < 64; i++) {
    const typeRoll = rand();
    const type: RegistrationType = typeRoll < 0.45 ? "individual" : "family";
    // Overseas mandals send a handful of people, not a fifth of the event.
    const mandal = chance(0.06) ? pick([...ABROAD]) : pick(MANDALS.filter(m => !ABROAD.has(m)));
    currentMandal = mandal;
    const abroad = ABROAD.has(mandal);
    const local = isLocalMandal(mandal);
    const schedule = pickSchedule(abroad);
    const surname = pick(SURNAMES);
    usedNames = new Set();

    const members: Member[] = [];
    let groupName: string | undefined;

    if (type === "individual") {
      const gender: Gender = chance(0.55) ? "male" : "female";
      members.push(
        makeMember(
          0,
          {
            firstName: nameFor(gender),
            surname,
            gender,
            age: between(17, 45),
            isPrimary: true,
          },
          schedule
        )
      );
    } else {
      groupName = `${surname} family`;
      const headAge = between(38, 62);
      members.push(
        makeMember(
          0,
          {
            firstName: nameFor("male"),
            surname,
            gender: "male",
            age: headAge,
            isPrimary: true,
          },
          schedule
        ),
        makeMember(
          1,
          {
            firstName: nameFor("female"),
            surname,
            gender: "female",
            age: headAge - between(1, 5),
            relation: "Spouse",
          },
          schedule
        )
      );
      const children = between(0, 3);
      for (let c = 0; c < children; c++) {
        const gender: Gender = chance(0.5) ? "male" : "female";
        members.push(
          makeMember(
            members.length,
            {
              firstName: nameFor(gender),
              surname,
              gender,
              age: between(6, Math.max(8, headAge - 22)),
              relation: gender === "male" ? "Son" : "Daughter",
            },
            schedule
          )
        );
      }
      if (chance(0.3)) {
        const gender: Gender = chance(0.5) ? "male" : "female";
        // A grandparent often heads home a day early; it is what makes the
        // per-member dates worth having.
        const leavesEarly = chance(0.5);
        members.push(
          makeMember(
            members.length,
            {
              firstName: nameFor(gender),
              surname,
              gender,
              age: between(66, 82),
              relation: gender === "male" ? "Father" : "Mother",
            },
            leavesEarly && schedule[0].date < EVENT_DAYS[1]
              ? [schedule[0], stay(EVENT_DAYS[1], "evening")]
              : schedule
          )
        );
      }
    }

    // Beds: most outstation parties want them; now and then one person in a
    // family stays with relatives in the city instead.
    const wantsBeds = !local && chance(0.9);
    const withRelatives =
      wantsBeds && members.length > 2 && chance(0.25) ? between(1, members.length - 1) : -1;
    members.forEach((m, index) => {
      m.needsAccommodation = wantsBeds && index !== withRelatives;
    });

    let travelMode: TravelMode;
    // Overseas devotees land at Ahmedabad airport (indiaTravel) and come on
    // from there.
    if (abroad) travelMode = "other";
    // Nearby mandals are not asked; they come from home.
    else if (local) travelMode = "local";
    else
      travelMode = pick([
        "personal_vehicle",
        "personal_vehicle",
        "train",
        "train",
        "flight",
        "public_bus",
        "mandal_bus",
      ] as const);

    const status: RegistrationStatus = i < 4 ? "cancelled" : "confirmed";

    const createdDay = between(1, 39);
    const createdAt = new Date(
      Date.UTC(2026, 8, createdDay, between(3, 16), between(0, 59))
    ).toISOString();

    const vehicleCount = members.length > 5 ? 2 : 1;
    const journey =
      travelMode === "train" || travelMode === "public_bus" || travelMode === "flight";
    const needsPickup = journey && chance(0.7);
    const needsDrop = needsPickup && chance(0.5);
    const referenceFor = (mode: string) =>
      mode === "train"
        ? pick(TRAINS)
        : mode === "flight"
          ? `${pick(["6E", "AI", "QP", "SG"])} ${between(200, 2999)}`
          : pick(BUSES);
    // Online registrations verify the number by OTP; at the desk a sanchalak
    // or admin may vouch for it in person instead.
    const source = chance(0.8) ? "self" : "staff";
    const inPerson = source === "staff" && chance(0.5);

    registrations.push({
      sequence: 0,
      code: "",
      memberCodes: [],
      type,
      groupName,
      mandal,
      members,
      arrival: schedule[0],
      departure: schedule[1],
      travel: {
        mode: travelMode,
        vehicleCount: travelMode === "personal_vehicle" ? vehicleCount : undefined,
        // Numbers are optional, so some samples leave them out.
        vehicleNumbers:
          travelMode === "personal_vehicle" && chance(0.85)
            ? Array.from(
                { length: vehicleCount },
                () =>
                  `${PLATE_PREFIX[mandal] ?? "GJ-01"}-${String.fromCharCode(65 + between(0, 25))}${String.fromCharCode(65 + between(0, 25))}-${between(1000, 9999)}`
              )
            : [],
        // By train, bus or flight: the journey in, timed to the arrival slot.
        ...(journey
          ? {
              reference: referenceFor(travelMode),
              arrivalTime: timeIn(schedule[0].slot),
              ...(travelMode === "train" ? { station: pick(TRAIN_STATIONS) } : {}),
            }
          : {}),
        needsPickup,
        // A drop comes only with a pickup, as on the form; the way home is
        // mostly the way they came, and timed to the departure slot.
        needsDrop,
        ...(needsDrop
          ? (() => {
              const home =
                travelMode === "flight" ? "flight" : pick([travelMode, travelMode, "train"]);
              return {
                departureMode: home,
                departureReference: referenceFor(home),
                ...(home === "train" ? { departureStation: pick(TRAIN_STATIONS) } : {}),
                departureTime: timeIn(schedule[1].slot),
              };
            })()
          : {}),
      },
      // Most overseas devotees fly into Ahmedabad and want a pickup; about half
      // give their flight out.
      indiaTravel:
        abroad && chance(0.8)
          ? (() => {
              const needsPickup = chance(0.75);
              const flyingOut = chance(0.5);
              const time = () =>
                `${String(between(0, 23)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}`;
              const flight = () => `${pick(["AI", "BA", "EK", "QR", "UA"])} ${between(100, 999)}`;
              return {
                needsPickup,
                ...(needsPickup
                  ? {
                      arrival: {
                        date: shiftDate(schedule[0].date, -between(0, 3)),
                        time: time(),
                        flight: flight(),
                      },
                    }
                  : {}),
                needsDrop: false,
                ...(flyingOut
                  ? {
                      departure: {
                        date: shiftDate(schedule[1].date, between(0, 3)),
                        time: time(),
                        flight: flight(),
                      },
                    }
                  : {}),
              };
            })()
          : undefined,
      accommodationRequired: wantsBeds,
      notes: chance(0.15)
        ? pick([
            "Will help with seva in the kitchen if needed.",
            "Arriving together with our mandal.",
            "Please keep the family in one room if possible.",
            "Requesting jain food for all members.",
          ])
        : undefined,
      status,
      source,
      mobileVerification: inPerson ? "in_person" : "otp",
      verifiedByName: inPerson ? pick(DESK_NAMES) : undefined,
      createdAt,
    });
  }

  // Codes go out in the order people registered, as they would on the server.
  registrations.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let people = 0;
  let families = 0;
  registrations.forEach((registration, index) => {
    registration.sequence = index + 1;
    registration.memberCodes = registration.members.map(() => formatPersonCode(++people, true));
    registration.code =
      registration.type === "family"
        ? formatFamilyCode(++families, true)
        : registration.memberCodes[0];
  });

  // Newest first, the way the list shows them.
  return registrations.reverse();
}

export const SAMPLE_COUNT = 64;

export const countSampleRegistrations = () =>
  prisma.registration.count({ where: { isSample: true } });

/**
 * Adds every sample registration that is not already there. Refuses (returns
 * `{ clash }`) if a real registration holds one of the sample codes — only
 * possible on a database that took real registrations before any samples.
 */
export async function insertSampleRegistrations() {
  const samples = buildSampleRegistrations();
  const taken = await prisma.registration.findMany({
    where: { sequence: { in: samples.map(s => s.sequence) } },
    select: { sequence: true, code: true, isSample: true },
  });
  const clash = taken.find(t => !t.isSample);
  if (clash) return { added: 0, clash: clash.code };

  const present = new Set(taken.map(t => t.sequence));
  let added = 0;
  // One by one rather than createMany, which skips @updatedAt and would leave
  // every sample without one.
  for (const sample of samples) {
    if (present.has(sample.sequence)) continue;
    const {
      sequence,
      code,
      memberCodes,
      status,
      source,
      createdAt,
      mobileVerification,
      verifiedByName,
      ...input
    } = sample;
    // The same check and shaping as POST /registrations.
    const data = toCreateData(newRegistrationSchema.parse(input));
    await prisma.registration.create({
      data: {
        ...data,
        members: data.members.map((m, index) => ({ ...m, code: memberCodes[index] })),
        sequence,
        code,
        status,
        source,
        isSample: true,
        mobileVerification,
        verifiedByName: verifiedByName ?? null,
        createdAt: new Date(createdAt),
      },
    });
    added++;
  }

  // Real registrations number on from after the samples. `$max` never moves
  // the counter back, so codes already handed out are never reused.
  await prisma.$runCommandRaw({
    update: "counter",
    updates: [{ q: { _id: "registration" }, u: { $max: { value: SAMPLE_COUNT } }, upsert: true }],
  });

  return { added, clash: null };
}

/** Deletes every sample registration, and nothing else — along with any rooms they were given. */
export async function removeSampleRegistrations() {
  const samples = await prisma.registration.findMany({
    where: { isSample: true },
    select: { id: true },
  });
  await prisma.roomAllotment.deleteMany({
    where: { registrationId: { in: samples.map(s => s.id) } },
  });
  // Their entries on the Logs screen go with them.
  await prisma.registrationChange.deleteMany({
    where: { registrationId: { in: samples.map(s => s.id) } },
  });
  const { count } = await prisma.registration.deleteMany({ where: { isSample: true } });
  return count;
}
