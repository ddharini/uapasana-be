/**
 * One-off, 13 Oct 2026: registrations are no longer confirmed by the team, so
 * "pending" is gone. Moves every registration still saved as "pending" to
 * "confirmed" (shown as "Registered"), and its log entries with it.
 *
 *   pnpm ts-node scripts/merge-pending-registrations.ts           shows what would change
 *   pnpm ts-node scripts/merge-pending-registrations.ts --apply   saves it
 *
 * Until it runs, the server already reads "pending" as "confirmed" (statusOf
 * in src/lib/event.ts). Running it again does nothing.
 */
import "../src/env";

import { prisma } from "../src/utils/db";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL ?? "";
  console.log(`Database: ${url ? new URL(url).host : "(none)"}${apply ? "" : " — dry run, nothing saved"}`);

  const pending = await prisma.registration.findMany({
    where: { status: "pending" },
    select: { code: true },
    orderBy: { sequence: "asc" },
  });
  const changes = await prisma.registrationChange.count({ where: { status: "pending" } });
  console.log(`${pending.length} registrations and ${changes} log entries say "pending".`);
  if (pending.length) console.log(pending.map(r => r.code).join(", "));
  if (!apply) return;

  const registrations = await prisma.registration.updateMany({
    where: { status: "pending" },
    data: { status: "confirmed" },
  });
  const logs = await prisma.registrationChange.updateMany({
    where: { status: "pending" },
    data: { status: "confirmed" },
  });
  console.log(`Moved ${registrations.count} registrations and ${logs.count} log entries to "confirmed".`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
