import { z } from "zod";

import { EVENT_DAYS, MANDALS, MOBILE_E164, NO_MANDAL } from "./event";

/**
 * Walk-in guests' rules, as the API enforces them. Mirrors the form in
 * upasana-fe/src/features/guests — change both together. The endpoint is
 * public, so anything the form refuses is refused here too.
 */

/** Meals a day guest can take. Breakfast is not served to day guests. */
export const GUEST_MEALS = ["lunch", "dinner"] as const;

/** Most people one entry can bring on a day. A bigger party is a call to the team. */
export const MAX_GUESTS_PER_DAY = 50;

/**
 * Most entries one host number can send from the public link. Generous for a
 * real host (one entry per party), and a ceiling on anyone filling the list
 * with junk — the link is public, and nothing else is verified.
 */
export const MAX_ENTRIES_PER_HOST = 20;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .optional()
    .nullable()
    .transform(v => v || null);

const guestDay = z.object({
  date: z.enum(EVENT_DAYS, { error: "Pick an event day" }),
  guests: z
    .number({ error: "Enter how many are coming" })
    .int("Enter a whole number")
    .min(1, "At least 1")
    .max(MAX_GUESTS_PER_DAY, `At most ${MAX_GUESTS_PER_DAY} — call the team for a bigger party`),
  meals: z
    .array(z.enum(GUEST_MEALS, { error: "Pick lunch or dinner" }))
    .transform(meals => GUEST_MEALS.filter(m => meals.includes(m))),
});

export const guestVisitSchema = z.object({
  hostName: z
    .string({ error: "Enter your name" })
    .trim()
    .min(1, "Enter your name")
    .max(80, "Keep it under 80 characters"),
  hostMobile: z
    .string({ error: "Enter a mobile number" })
    .regex(MOBILE_E164, "Enter a valid mobile number"),
  hostMandal: z.enum([...MANDALS, NO_MANDAL], { error: "Pick your mandal" }),
  guestNames: optionalText(300),
  days: z
    .array(guestDay, { error: "Pick at least one day" })
    .min(1, "Pick at least one day")
    .refine(days => new Set(days.map(d => d.date)).size === days.length, "Each day once")
    .transform(days => [...days].sort((a, b) => a.date.localeCompare(b.date))),
  notes: optionalText(300),
});

export type GuestVisitInput = z.infer<typeof guestVisitSchema>;
