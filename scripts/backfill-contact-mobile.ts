/**
 * One-off: fills `contactMobile` (the field the one-registration-per-number
 * unique index is on) from each registration's primary contact.
 *
 *   npx ts-node scripts/backfill-contact-mobile.ts
 *
 * Safe to run again: it only touches documents without the field. Run it
 * BEFORE scripts/ensure-partial-indexes.ts — and if it reports numbers used
 * twice, resolve those first, or the unique index refuses to build.
 */
import "../src/env";

import { prisma } from "../src/utils/db";

async function main() {
  const result = (await prisma.$runCommandRaw({
    update: "registration",
    updates: [
      {
        q: { contactMobile: { $exists: false } },
        u: [{ $set: { contactMobile: { $arrayElemAt: ["$members.mobile", 0] } } }],
        multi: true,
      },
    ],
  })) as { nModified?: number };
  console.log(`Filled contactMobile on ${result.nModified ?? 0} registrations.`);

  const all = await prisma.registration.findMany({ select: { code: true, contactMobile: true } });
  const seen = new Map<string, string>();
  for (const r of all) {
    if (!r.contactMobile) continue;
    const first = seen.get(r.contactMobile);
    if (first) console.warn(`Number used twice: ${r.contactMobile} on ${first} and ${r.code}`);
    else seen.set(r.contactMobile, r.code);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
