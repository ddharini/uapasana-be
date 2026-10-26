/**
 * Fills in a placeholder programme for 29 Jan – 1 Feb 2027, so the schedule screen
 * has something to show and edit before the committee confirms timings.
 *
 *   pnpm seed:schedule           only when there are no days yet
 *   pnpm seed:schedule --reset   deletes EVERY schedule day first
 */
import "../src/env";

import { randomUUID } from "node:crypto";

import { prisma } from "../src/utils/db";

type Session = {
  start: string;
  end: string;
  title: string;
  kind: "sabha" | "aarti" | "prasad" | "cultural";
  place: string;
  note?: string;
};

const SABHA_MANDAP = "Main Sabha Mandap";
const BHOJANALAYA = "Bhojanalaya";
const MANDIR = "Mandir";

/** The routine every day shares; the sabhas are named per day below. */
function day(
  date: string,
  {
    theme,
    morningSabha = "Morning Sabha",
    eveningSabha = "Evening Sabha",
    cultural = "Sanskrutik Karyakram",
    morningNote,
    eveningNote,
    culturalNote,
  }: {
    theme?: string;
    morningSabha?: string;
    eveningSabha?: string;
    cultural?: string;
    morningNote?: string;
    eveningNote?: string;
    culturalNote?: string;
  } = {}
) {
  const sessions: Session[] = [
    { start: "06:00", end: "06:30", title: "Mangla Aarti", kind: "aarti", place: MANDIR },
    { start: "08:00", end: "09:00", title: "Nashto", kind: "prasad", place: BHOJANALAYA },
    { start: "10:00", end: "12:30", title: morningSabha, kind: "sabha", place: SABHA_MANDAP, note: morningNote },
    { start: "13:00", end: "14:30", title: "Mahaprasad", kind: "prasad", place: BHOJANALAYA },
    { start: "16:00", end: "18:00", title: eveningSabha, kind: "sabha", place: SABHA_MANDAP, note: eveningNote },
    { start: "18:30", end: "19:00", title: "Sandhya Aarti", kind: "aarti", place: MANDIR },
    { start: "19:00", end: "21:00", title: cultural, kind: "cultural", place: SABHA_MANDAP, note: culturalNote },
    { start: "21:00", end: "22:00", title: "Bhojan", kind: "prasad", place: BHOJANALAYA },
  ];
  return {
    date,
    theme: theme ?? null,
    sessions: sessions.map((s) => ({ id: randomUUID(), ...s, note: s.note ?? null })),
  };
}

const DAYS = [
  day("2027-01-29", {
    theme: "Opening day",
    morningSabha: "Udghatan Sabha",
    morningNote: "Inauguration with deep pragatya and welcome addresses.",
    culturalNote: "Welcome performances by the host mandal.",
  }),
  day("2027-01-30", { cultural: "Bhakti Sangeet Sandhya" }),
  day("2027-01-31", { culturalNote: "Inter-mandal performances." }),
  day("2027-02-01", {
    theme: "Closing day",
    eveningSabha: "Samapan Sabha",
    eveningNote: "Closing sabha and vote of thanks.",
    cultural: "Mahaarti & Farewell",
  }),
];

async function main() {
  if (process.argv.includes("--reset")) {
    const { count } = await prisma.scheduleDay.deleteMany({});
    console.log(`Deleted ${count} schedule days.`);
  } else {
    const existing = await prisma.scheduleDay.count();
    if (existing > 0) {
      console.log(`The schedule already has ${existing} days; left as it is. Pass --reset to replace it.`);
      return;
    }
  }

  for (const data of DAYS) await prisma.scheduleDay.create({ data });
  console.log(`Seeded ${DAYS.length} schedule days (${DAYS[0].date} to ${DAYS[DAYS.length - 1].date}).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
