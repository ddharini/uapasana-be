/**
 * One-off: moves each registration's single `travel.vehicleNumber` into the
 * `travel.vehicleNumbers` list that replaced it.
 *
 *   npx ts-node scripts/migrate-vehicle-numbers.ts
 *
 * Safe to run more than once: it only touches documents that still have the
 * old field, and every document ends up with a list (empty when there was no
 * number). Raw, because the Prisma client no longer knows the old field.
 */
import "../src/env";

import { prisma } from "../src/utils/db";

async function main() {
  const result = (await prisma.$runCommandRaw({
    update: "registration",
    updates: [
      {
        q: { "travel.vehicleNumbers": { $exists: false } },
        u: [
          {
            $set: {
              "travel.vehicleNumbers": {
                $cond: [{ $ifNull: ["$travel.vehicleNumber", false] }, ["$travel.vehicleNumber"], []],
              },
            },
          },
          { $unset: "travel.vehicleNumber" },
        ],
        multi: true,
      },
    ],
  })) as { n?: number; nModified?: number };
  console.log(`Moved vehicle numbers on ${result.nModified ?? 0} of ${result.n ?? 0} registrations.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
