import { z } from "zod";

/**
 * The event programme's rules, as the API enforces them. Mirrors the dialogs
 * in upasana-fe/src/features/schedule — change both together.
 */

/** Built-in types. Anything else in `kind` is a custom type an admin named. */
export const SESSION_KINDS = ["sabha", "aarti", "prasad", "cultural"] as const;

/**
 * A Google Maps link: maps.app.goo.gl short links, goo.gl/maps, google.<tld>/maps
 * and maps.google.<tld>. Only these, because the link is rendered as an href —
 * anything looser would let a `javascript:` URL through.
 */
export const GOOGLE_MAPS_URL =
  /^https?:\/\/(maps\.app\.goo\.gl\/|goo\.gl\/maps\/|(www\.)?google\.[a-z.]{2,6}\/maps|maps\.google\.[a-z.]{2,6}(\/|\?|$))\S*$/i;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar day as "YYYY-MM-DD" — "2027-02-30" is refused. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date")
  .refine(value => {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, "Pick a date");

/** Empty or whitespace becomes absent, so clearing a field removes it. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .optional()
    .transform(value => value || undefined);

export const daySchema = z.object({
  date: isoDate,
  theme: optionalText(60),
});

const times = z.object({
  start: z.string().regex(TIME, "Enter a start time"),
  end: z.string().regex(TIME, "Enter an end time"),
});

export const sessionSchema = z
  .object({
    ...times.shape,
    title: z.string().trim().min(1, "Enter a name").max(80, "Keep it under 80 characters"),
    kind: z.string().trim().min(1, "Pick a type").max(30, "Keep the type under 30 characters"),
    place: optionalText(60),
    mapUrl: z
      .string()
      .trim()
      .max(500, "That link is too long")
      .refine(v => !v || GOOGLE_MAPS_URL.test(v), "Paste a Google Maps link")
      .optional()
      .transform(v => v || undefined),
    note: optionalText(300),
  })
  .refine(s => s.place || s.mapUrl, { path: ["place"], message: "Enter a place or a map link" })
  // "HH:MM" compares correctly as a string. `when` runs this as soon as both
  // times are valid, so it is reported alongside a missing name, not after.
  .refine(s => s.end > s.start, {
    path: ["end"],
    message: "End after it starts",
    when: payload => times.safeParse(payload.value).success,
  });

type Session = { start: string; end: string };

/** By start time, then the shorter first — the order the timeline shows. */
export const bySessionTime = (a: Session, b: Session) =>
  a.start.localeCompare(b.start) || a.end.localeCompare(b.end);

/** What the frontend gets: a day with its sessions in timeline order. */
export function toDayDto<T extends { sessions: Session[] }>(day: T): T {
  return { ...day, sessions: [...day.sessions].sort(bySessionTime) };
}

type StoredDay = {
  date: string;
  theme: string | null;
  sessions: {
    id: string;
    start: string;
    end: string;
    title: string;
    kind: string;
    place: string | null;
    mapUrl: string | null;
    note: string | null;
  }[];
};

/**
 * The programme as devotees see it: date order, sessions in time order, and
 * nothing internal (no day ids, no who-edited-when). Keys are written in a
 * fixed order so two snapshots of the same programme stringify identically —
 * that comparison is how "unpublished changes" is worked out.
 */
export function snapshotOf(days: StoredDay[]) {
  return [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(day => ({
      date: day.date,
      theme: day.theme ?? null,
      sessions: [...day.sessions].sort(bySessionTime).map(s => ({
        id: s.id,
        start: s.start,
        end: s.end,
        title: s.title,
        kind: s.kind,
        place: s.place ?? null,
        mapUrl: s.mapUrl ?? null,
        note: s.note ?? null,
      })),
    }));
}

export type ScheduleSnapshot = ReturnType<typeof snapshotOf>;
