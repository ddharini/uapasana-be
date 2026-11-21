/**
 * The daily reports, by hand (lib/daily-report.ts).
 *
 *   pnpm report:daily [--youth] <file.xlsx>                writes the workbook, sends nothing
 *   pnpm report:daily [--youth] --send <number>[,<number>]  sends it on WhatsApp now
 *
 * Without `--youth`, the registration report; with it, the Youth Convention one.
 *
 * Reads whichever database `DATABASE_URL` names — print-checked below — and
 * never writes to it beyond the WhatsApp message log. A `--send` is a paid
 * Utility message per number, logged under the report's test purpose, so it
 * never stands in for the scheduled report: the people it went to still get that one.
 */
import "../src/env";

import { writeFile } from "fs/promises";

import {
  REGISTRATION_REPORT,
  YOUTH_REPORT,
  parseRecipients,
  sendReport,
} from "../src/lib/daily-report";
import { prisma } from "../src/utils/db";

const host = (process.env.DATABASE_URL ?? "").replace(/^.*@([^/?]+).*$/, "$1") || "(none)";
const USAGE =
  "Usage: pnpm report:daily [--youth] <file.xlsx> | [--youth] --send <number>[,<number>]";

async function main() {
  let args = process.argv.slice(2);
  const kind = args[0] === "--youth" ? YOUTH_REPORT : REGISTRATION_REPORT;
  if (args[0] === "--youth") args = args.slice(1);
  console.log(`Database: ${host}`);
  console.log(`Report: ${kind.name}`);

  if (args[0] === "--send") {
    const recipients = parseRecipients(args.slice(1).join(","));
    if (recipients.length === 0) throw new Error(USAGE);
    const { report, results } = await sendReport(kind, recipients, kind.testPurpose);
    console.log(`Values: ${report.values.join(" | ")}`);
    for (const result of results)
      console.log(
        `${result.to}: ${result.waMessageId ? `accepted ${result.waMessageId}` : result.error}`
      );
    return;
  }

  const path = args[0];
  if (!path) throw new Error(USAGE);
  const report = await kind.build(new Date());
  await writeFile(path, report.bytes);
  console.log(`Values: ${report.values.join(" | ")}`);
  console.log(`${report.summary} → ${path}`);
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
