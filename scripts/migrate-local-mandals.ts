/**
 * One-off, for the local-mandal change of 2026-10-13: Naroda left the mandal
 * list (it is part of Ahmedabad), and only Ahmedabad, Dahegam and Gandhinagar
 * stay local.
 *
 *   npx tsx scripts/migrate-local-mandals.ts
 *
 * - Naroda registrations move to Ahmedabad (still local, so their travel stays).
 * - Vadodara and Rajkot registrations stored as travel "local" get
 *   "not_filled": they were never asked, and the next edit has to choose.
 *
 * Safe to run more than once: each update only matches what it still has to change.
 */
import "../src/env";

import { prisma } from "../src/utils/db";

async function main() {
  console.log(`Database: ${new URL(process.env.DATABASE_URL!.replace(/^mongodb(\+srv)?/, "http")).host}`);
  const result = (await prisma.$runCommandRaw({
    update: "registration",
    updates: [
      { q: { mandal: "Naroda" }, u: { $set: { mandal: "Ahmedabad" } }, multi: true },
      {
        q: { mandal: { $in: ["Vadodara", "Rajkot"] }, "travel.mode": "local" },
        u: { $set: { "travel.mode": "not_filled" } },
        multi: true,
      },
    ],
  })) as { n?: number; nModified?: number };
  console.log(`Updated ${result.nModified ?? 0} of ${result.n ?? 0} matching registrations.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
