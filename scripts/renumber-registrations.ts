/**
 * One-off, 13 Oct 2026: moves registrations numbered the old way (one
 * "YC-0142" per registration) to the new numbers — "DM-0101" for each person,
 * "DM-F-0101" for each family (src/lib/registration-codes.ts).
 *
 *   pnpm ts-node scripts/renumber-registrations.ts           shows what would change
 *   pnpm ts-node scripts/renumber-registrations.ts --apply   saves it
 *
 * Oldest registration first. Numbers come from the same counters as new
 * registrations, so one submitted meanwhile cannot get a number twice; a
 * registration whose people all have numbers already is left alone, so
 * running it again does nothing. Log entries take the new registration code.
 */
import "../src/env";

import { formatFamilyCode, formatPersonCode } from "../src/lib/event";
import { takeNumbers } from "../src/lib/registration-codes";
import { prisma } from "../src/utils/db";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL ?? "";
  console.log(`Database: ${url ? new URL(url).host : "(none)"}${apply ? "" : " — dry run, nothing saved"}`);

  const registrations = await prisma.registration.findMany({ orderBy: { sequence: "asc" } });
  const todo = registrations.filter(r => r.members.some(m => !m.code));
  console.log(`${todo.length} of ${registrations.length} registrations need numbers.`);

  let person = 0;
  let family = 0;
  for (const r of todo) {
    const numbers = apply
      ? await takeNumbers("person", r.members.length)
      : r.members.map(() => ++person);
    const members = r.members.map((m, i) => ({ ...m, code: formatPersonCode(numbers[i]) }));
    const code =
      r.type === "family"
        ? formatFamilyCode(apply ? (await takeNumbers("family", 1))[0] : ++family)
        : members[0].code;

    console.log(`${r.code} → ${code}  (${members.map(m => `${m.code} ${m.fullName}`).join(", ")})`);
    if (!apply) continue;

    await prisma.registration.update({ where: { id: r.id }, data: { code, members } });
    await prisma.registrationChange.updateMany({ where: { registrationId: r.id }, data: { code } });
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
