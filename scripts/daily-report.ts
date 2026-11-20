/**
 * The daily registration report, by hand (lib/daily-report.ts).
 *
 *   pnpm report:daily <file.xlsx>                writes the workbook, sends nothing
 *   pnpm report:daily --send <number>[,<number>]  sends it on WhatsApp now
 *
 * Reads whichever database `DATABASE_URL` names — print-checked below — and
 * never writes to it beyond the WhatsApp message log. A `--send` is a paid
 * Utility message per number, logged as `whatsapp:daily_report_test`, so it
 * never stands in for the 4 pm report: the people it went to still get that one.
 */
import "../src/env";

import { writeFile } from "fs/promises";

import {
  DAILY_REPORT_TEST_PURPOSE,
  buildDailyReport,
  parseRecipients,
  sendDailyReport,
  templateValues,
} from "../src/lib/daily-report";
import { prisma } from "../src/utils/db";

const host = (process.env.DATABASE_URL ?? "").replace(/^.*@([^/?]+).*$/, "$1") || "(none)";

async function main() {
  const args = process.argv.slice(2);
  console.log(`Database: ${host}`);

  if (args[0] === "--send") {
    const recipients = parseRecipients(args.slice(1).join(","));
    if (recipients.length === 0)
      throw new Error("Usage: pnpm report:daily --send <number>[,<number>]");
    const { report, results } = await sendDailyReport(recipients, DAILY_REPORT_TEST_PURPOSE);
    console.log(`Values: ${templateValues(report).join(" | ")}`);
    for (const result of results)
      console.log(
        `${result.to}: ${result.waMessageId ? `accepted ${result.waMessageId}` : result.error}`
      );
    return;
  }

  const path = args[0];
  if (!path) throw new Error("Usage: pnpm report:daily <file.xlsx> | --send <number>[,<number>]");
  const { report, bytes } = await buildDailyReport();
  await writeFile(path, bytes);
  console.log(`Values: ${templateValues(report).join(" | ")}`);
  console.log(`${report.registrations} registrations, ${report.people} people → ${path}`);
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
