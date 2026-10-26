/**
 * Loads the 64 sample registrations (src/lib/sample-registrations.ts) — the
 * same thing as "Show dummy data" on the Registrations screen.
 *
 *   pnpm seed:registrations           adds any samples that are missing
 *   pnpm seed:registrations --reset   deletes EVERY registration, real ones
 *                                     included, then adds the samples
 */
import "../src/env";

import { SAMPLE_COUNT, insertSampleRegistrations } from "../src/lib/sample-registrations";
import { prisma } from "../src/utils/db";

async function main() {
  if (process.argv.includes("--reset")) {
    const { count } = await prisma.registration.deleteMany();
    console.log(`Deleted ${count} registrations.`);
  }

  const { added, clash } = await insertSampleRegistrations();
  if (clash) {
    console.log(
      `${clash} is a real registration, so the samples cannot use their codes. Nothing seeded.`
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Added ${added} sample registrations (numbered DMS-…); ` +
      `${SAMPLE_COUNT - added} were already there.`
  );
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
