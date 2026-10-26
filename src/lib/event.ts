/**
 * The event's fixed facts, as the API enforces them.
 *
 * A copy of upasana-fe/src/config/event.ts and the enum maps in
 * upasana-fe/src/features/registrations/types.ts. The frontend uses its copy to
 * draw the form; this one is what a registration is checked against, so a
 * request that skips the form still cannot store a date outside the event or a
 * mandal that does not exist. Change both together.
 */

/** Team roles an admin can invite. */
export const INVITE_ROLES = ["admin", "sanchalak"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/** "an admin", "Mandal sanchalak for Surat" — for invite messages. */
export function roleDescription(role: string, mandal?: string | null) {
  return role === "sanchalak" ? `Mandal sanchalak for ${mandal ?? "your mandal"}` : "an admin";
}

/** Shown in WhatsApp messages. Matches `EVENT.name` on the frontend. */
export const EVENT_NAME = "Dashabdi Mahotsav";

/** The event days, 29 Jan – 1 Feb 2027. Calendar days at the venue, no time zone. Mirrors `EVENT.days` on the frontend. */
export const EVENT_DAYS = ["2027-01-29", "2027-01-30", "2027-01-31", "2027-02-01"] as const;

/** Days a guest may arrive: the day before the event, and the event days. Mirrors the frontend. */
export const ARRIVAL_DATES = ["2027-01-28", ...EVENT_DAYS] as const;
/** Days a guest may leave: the same as arriving, the day before included. Mirrors the frontend. */
export const DEPARTURE_DATES = ARRIVAL_DATES;
/** Every day a guest can be here, first to last. */
export const STAY_DATES = ARRIVAL_DATES;

/** "2027-01-01" … "2027-02-28": every calendar day from `first` to `last`. */
function daysBetween(first: string, last: string) {
  const days: string[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); d.toISOString().slice(0, 10) <= last; ) {
    days.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return days as [string, ...string[]];
}

/**
 * Days someone arriving early for seva as a Swayam Sevak (`earlySeva`) may
 * arrive and leave: all of January and February 2027, the event's months.
 * Everyone else is held to ARRIVAL_DATES / DEPARTURE_DATES. Mirrors SEVA_DATES
 * on the frontend.
 */
export const SEVA_DATES = daysBetween("2027-01-01", "2027-02-28");

/**
 * Nights someone can need a bed: every stay date but the last, since nobody
 * sleeps over after leaving. A night is named by its evening's date.
 */
export const NIGHTS = STAY_DATES.slice(0, -1);

/** "30 Jan" — for messages. */
export function formatDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export const TIME_SLOTS = ["morning", "afternoon", "evening"] as const;

/** The ways of travelling a pickup and drop in Ahmedabad are offered for. Mirrors DROP_MODES on the frontend. */
export const JOURNEY_MODES = ["train", "public_bus", "flight"] as const;
export const isJourneyMode = (mode: string): mode is (typeof JOURNEY_MODES)[number] =>
  (JOURNEY_MODES as readonly string[]).includes(mode);

/** The oldest age asked whether they will attend the Youth Convention. Mirrors the frontend. */
export const YOUTH_MAX_AGE = 40;

/** The Ahmedabad stations a train can arrive at. Mirrors TRAIN_STATIONS on the frontend. */
export const TRAIN_STATIONS = [
  "Kalupur (Ahmedabad Junction)",
  "Sabarmati",
  "Chandlodiya",
  "Maninagar",
] as const;

/** Mandals outside India. Mirrors OVERSEAS_MANDALS on the frontend. */
export const OVERSEAS_MANDALS: readonly string[] = [
  "UK",
  "USA",
  "Canada",
  "Australia",
  "New Zealand",
  "Dubai",
  "France",
  "Kenya",
];

export const MANDALS = [
  "Ahmedabad",
  "Gandhinagar",
  "Dehgam",
  "SabarKantha",
  "Sathamba",
  "Nadiad",
  "Khambhat",
  "Anand",
  "Vidyanagar",
  "Mogri",
  "Baroda",
  "Vemar",
  "Ankleshwar",
  "Surat",
  "Barasadi",
  "Mumbai",
  "Pune",
  "Hyderabad",
  "Chennai",
  "Kochi",
  "Morbi",
  "Dhari",
  "Bhingrad",
  "Manavadar",
  "Rajkot",
  "Junagadh",
  "Bhavnagar",
  "Rajpipla",
  "Jasdan",
  "Delhi",
  "South Gujarat",
  "North Gujarat",
  "Central Gujarat",
  "Kutch-Saurashtra",
  "Charotar Pradesh",
  "Kanam Pradesh",
  "UK",
  "USA",
  "Canada",
  "Australia",
  "New Zealand",
  "Dubai",
  "France",
  "Kenya",
] as const;

export const NO_MANDAL = "Not in a mandal";

/**
 * Mandals near enough to come and go from home: Ahmedabad, and
 * these. Not asked about travel or a bed; stored as travel "local", no beds.
 * Mirrors isLocalMandal in upasana-fe/src/config/event.ts.
 */
const LOCAL_MANDALS: readonly string[] = ["Dehgam", "Gandhinagar"];
export const isLocalMandal = (mandal: string) =>
  mandal.startsWith("Ahmedabad") || LOCAL_MANDALS.includes(mandal);

export const REGISTRATION_TYPES = ["individual", "family"] as const;
export const GENDERS = ["male", "female"] as const;

/** The most vehicles a registration can bring. Mirrors MAX_VEHICLES in the frontend's form schema. */
export const MAX_VEHICLES = { individual: 1, family: 4 } as const;

/** No more vehicles than people: one for an individual, up to four for a family. */
export function maxVehiclesFor(type: (typeof REGISTRATION_TYPES)[number], people: number) {
  return Math.max(1, Math.min(MAX_VEHICLES[type], people));
}

/** "gj 05-ab 1234" → "GJ05AB1234": how two plates are compared. */
export const normalizePlate = (plate: string) => plate.toUpperCase().replace(/[\s.-]/g, "");

/**
 * An Indian number plate, after `normalizePlate`: state, district, up to three
 * series letters, four digits (GJ05AB1234), or a Bharat series plate
 * (22BH1234AB). Mirrors isVehiclePlate in the frontend's form schema.
 */
export const isVehiclePlate = (plate: string) =>
  /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(normalizePlate(plate)) ||
  /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(normalizePlate(plate));

/** A family's primary contact has to be an adult. (Someone registering alone may be younger.) */
export const MIN_FAMILY_CONTACT_AGE = 18;

/** Relations that fix the person's gender. Mirrors RELATION_GENDER in the frontend's types.ts. */
export const RELATION_GENDER: Record<string, (typeof GENDERS)[number]> = {
  Son: "male",
  Father: "male",
  Brother: "male",
  Grandfather: "male",
  Daughter: "female",
  Mother: "female",
  Sister: "female",
  Grandmother: "female",
};
export const TRAVEL_MODES = [
  "personal_vehicle",
  "mandal_bus",
  "train",
  "flight",
  "public_bus",
  "other",
  // Set for local mandals, never picked.
  "local",
  // Set on registrations whose mandal stopped being local before they gave
  // travel details; never picked, so the next edit has to choose a mode.
  "not_filled",
  // Set when the party does not all travel the same way (2026-10-25): each
  // person's own mode and journey are on `members[].travel`. Never picked.
  "separate",
] as const;

/** The modes a person can pick for themselves: none of the ones set by the form. */
export const PERSON_TRAVEL_MODES = [
  "personal_vehicle",
  "mandal_bus",
  "train",
  "flight",
  "public_bus",
  "other",
] as const;
/**
 * "confirmed" is every registration that is neither checked in nor cancelled,
 * shown as "Registered": there is no review step. Registrations saved before
 * that may still say "pending"; they are read as "confirmed" (statusOf).
 */
export const REGISTRATION_STATUSES = ["confirmed", "checked_in", "cancelled"] as const;

/** A stored status as it is shown: the old "pending" is "confirmed". */
export const statusOf = (stored: string) => (stored === "pending" ? "confirmed" : stored);

/**
 * Mobile numbers the form accepts, as E.164. Mirrors upasana-fe/src/lib/phone.ts:
 * India 6–9 then 9 digits; USA/Canada and UK 10 digits; Australia 4 + 8;
 * New Zealand 2 + 7 to 9; UAE 5 + 8.
 */
export const MOBILE_E164 =
  /^(\+91[6-9]\d{9}|\+1\d{10}|\+44\d{10}|\+614\d{8}|\+642\d{7,9}|\+9715\d{8})$/;

export type StayPoint = { date: string; slot: string; meal?: boolean | null };

/** Negative when `a` comes first. ISO dates compare correctly as strings. */
export function compareStay(a: StayPoint, b: StayPoint) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return TIME_SLOTS.indexOf(a.slot as never) - TIME_SLOTS.indexOf(b.slot as never);
}

/**
 * Registration numbers (src/lib/registration-codes.ts). Every person gets
 * their own, "DM-0101" for the first; a family registration as a whole also
 * gets one, "DM-F-0101" for the first family. The dummy registrations use
 * "DMS-" instead, so they can never take a real person's number.
 */
const numbered = (n: number) => (100 + n).toString().padStart(4, "0");
export const formatPersonCode = (n: number, sample = false) => `${sample ? "DMS" : "DM"}-${numbered(n)}`;
export const formatFamilyCode = (n: number, sample = false) => `${sample ? "DMS" : "DM"}-F-${numbered(n)}`;
export const isFamilyCode = (code: string) => /^DMS?-F-/.test(code);
