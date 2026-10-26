import "../src/env";

import { prisma } from "../src/utils/db";

/**
 * Writes schema defaults onto documents that predate the field.
 *
 *   npx ts-node scripts/backfill-defaults.ts
 *
 * **Run this after adding a required field with a `@default` to a model that
 * already has rows**, alongside `prisma db push`.
 *
 * ## Why this is needed at all
 *
 * MongoDB stores no schema, so adding `archived Boolean @default(false)` to a
 * model changes nothing about the documents already in the collection — they
 * simply have no `archived` key. Prisma papers over that on *reads*: a
 * `select` returns `false` for the missing field, so every row looks correct.
 *
 * It does not paper over it on *filters*. `where: { archived: false }` is sent
 * to MongoDB as `{ archived: false }`, which does not match a document that
 * lacks the field — and neither does `{ not: true }`. So the rows are there,
 * they read back correctly one at a time, and they vanish from every filtered
 * query.
 *
 * Each entry below is one field that has been added since its collection had
 * data. Entries are safe to leave in place forever: the filter only matches
 * documents still missing the field, so a second run updates nothing.
 */

interface Backfill {
  /** The MongoDB collection name — the `@@map` value, not the Prisma model. */
  collection: string;
  field: string;
  /** Narrow rather than `unknown`, so it satisfies Prisma's `InputJsonValue`. */
  value: boolean | number | string | null;
  /** What this field is, for the log line. */
  note: string;
}

// Example:
//   { collection: "post", field: "archived", value: false, note: "hidden from the feed" },
const BACKFILLS: Backfill[] = [
  // Samples seeded before this flag existed were marked `true` by hand on
  // 2026-10-10 (sequences 1–64 without a verified mobile) after this ran.
  { collection: "registration", field: "isSample", value: false, note: "not a demo registration" },
];

const main = async (): Promise<void> => {
  console.log("Backfilling schema defaults onto older documents\n");

  for (const { collection, field, value, note } of BACKFILLS) {
    const result = (await prisma.$runCommandRaw({
      update: collection,
      updates: [
        {
          q: { [field]: { $exists: false } },
          u: { $set: { [field]: value } },
          multi: true,
        },
      ],
    })) as { n?: number; nModified?: number };

    const changed = result.nModified ?? result.n ?? 0;
    console.log(
      `  ${collection}.${field}`.padEnd(30) +
        (changed > 0 ? `set on ${changed} document(s)` : "already present") +
        `  — ${note}`
    );
  }

  console.log("\nDone.");
  await prisma.$disconnect();
};

main().catch(async (error) => {
  console.error("\nBackfill failed:", (error as Error).message, "\n");
  await prisma.$disconnect();
  process.exit(1);
});
