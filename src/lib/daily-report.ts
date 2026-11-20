import type { Registration } from "@prisma/client";
import writeXlsxFile, { type Row } from "write-excel-file/node";

import { prisma } from "../utils/db";
import { EVENT_NAME, formatDay } from "./event";
import { STATUS_LABELS, TRAVEL_LABELS } from "./registration-pdf";
import { isSevak, wantsBed } from "./registrations";
import {
  WHATSAPP_TEMPLATES,
  WhatsAppSendError,
  isWhatsAppConfigured,
  sendWhatsAppTemplate,
  toWhatsAppNumber,
  uploadWhatsAppMedia,
} from "./whatsapp";

/**
 * The daily registration report: an Excel workbook sent on WhatsApp, at 4 pm
 * India time, to the numbers in `DAILY_REPORT_TO` (owner's request, 2026-11-21).
 *
 * **Why individual numbers and not a group.** The Cloud API can post to a group
 * only for an Official Business Account (the blue tick), only to a group the
 * business created through the API, and only up to 8 people. The trust's number
 * is not an OBA, so the report goes to each person's own chat instead.
 *
 * **The message is a template with a document header** (`daily_registration_report`,
 * Utility, English) — outside a 24-hour reply window a business may send only
 * approved templates. The workbook is uploaded to Meta once per run and the same
 * media id goes to every recipient. Each recipient is one paid Utility message.
 *
 * **The day's send is recorded only as `WhatsAppMessage` rows** with purpose
 * `whatsapp:daily_report`, so whether someone has had today's report survives a
 * restart without a new collection. Hostinger stops an idle app and starts it on
 * the next request (code context §4.1), so a timer counting from boot cannot be
 * trusted to be awake at 4 pm: the scheduler instead asks, every few minutes,
 * "is it past the hour, and who has not had today's report?" — the same shape as
 * the backups (lib/backup.ts). An app asleep at 4 pm sends on its first request
 * after, the same day; a day it never wakes is skipped, never sent the next day.
 *
 * A number Meta refuses is tried again at the next check, up to
 * `MAX_ATTEMPTS_PER_DAY` times a day, so a typo in `DAILY_REPORT_TO` costs a few
 * log lines rather than a refusal every five minutes until midnight.
 *
 * Counts follow the Reports screen's default ("Not cancelled"): cancelled
 * registrations and dummy data (`isSample`) are left out of every number and of
 * the list; cancellations are counted on their own line of the summary.
 */

export const DAILY_REPORT_PURPOSE = "whatsapp:daily_report";
/** Sends from the script or a test, kept apart so they never count as the day's report. */
export const DAILY_REPORT_TEST_PURPOSE = "whatsapp:daily_report_test";

const DEFAULT_AT = "16:00";
const MAX_ATTEMPTS_PER_DAY = 3;
const CHECK_EVERY_MS = 5 * 60 * 1000;
const FIRST_CHECK_AFTER_MS = 60 * 1000;
/** India has no daylight saving: IST is always UTC+5:30. */
const IST_OFFSET_MS = 330 * 60 * 1000;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface DailyReportConfig {
  /** Country code and number, digits only, de-duplicated. */
  recipients: string[];
  /** Minutes after midnight IST the report is due. */
  atMinutes: number;
}

/** "16:00" → 960. Anything else falls back to 4 pm. */
export function parseReportTime(value: string | undefined): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? DEFAULT_AT).trim());
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!(hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60)) return 16 * 60;
  return hours * 60 + minutes;
}

/**
 * `DAILY_REPORT_TO`: numbers separated by commas, any common form
 * (`+91 98…`, `98…`). One that cannot be a phone number is skipped with a
 * warning rather than stopping everyone else's report.
 */
export function parseRecipients(value: string | undefined): string[] {
  const recipients = new Set<string>();
  // Split on commas and semicolons only: "+91 98765 43210" has spaces inside it.
  for (const raw of (value ?? "").split(/[,;\n]+/)) {
    if (!raw.trim()) continue;
    try {
      recipients.add(toWhatsAppNumber(raw));
    } catch {
      console.warn(
        `[Daily report] Skipping "${raw.trim()}" in DAILY_REPORT_TO: not a phone number.`
      );
    }
  }
  return [...recipients];
}

/** Read at call time, like every env read in this tree, so a restart picks up a change. */
export function dailyReportConfig(): DailyReportConfig {
  return {
    recipients: parseRecipients(process.env.DAILY_REPORT_TO),
    atMinutes: parseReportTime(process.env.DAILY_REPORT_AT),
  };
}

// ---------------------------------------------------------------------------
// Time, in India
// ---------------------------------------------------------------------------

/** The calendar day in India ("2026-11-21"), minutes past midnight there, and when that day began. */
export function istClock(now: Date) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const date = shifted.toISOString().slice(0, 10);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const dayStart = new Date(Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS);
  return { date, minutes, dayStart };
}

/** "21 Nov 2026, 4:00 pm" in India. */
export function formatIst(at: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  })
    .format(at)
    .replace(/\b(AM|PM)\b/, match => match.toLowerCase());
}

/** "2026-11-21 16:05" in India — sorts as text, so the column sorts in Excel. */
const sortableIst = (at: Date) =>
  new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

type ReportRegistration = Pick<
  Registration,
  | "code"
  | "sequence"
  | "type"
  | "mandal"
  | "members"
  | "travel"
  | "accommodationRequired"
  | "earlySeva"
  | "status"
  | "contactMobile"
  | "createdAt"
>;

export interface MandalLine {
  mandal: string;
  registrations: number;
  people: number;
  male: number;
  female: number;
  beds: number;
  newPeople: number;
}

export interface DailyReport {
  at: Date;
  registrations: number;
  people: number;
  families: number;
  individuals: number;
  checkedIn: number;
  cancelled: number;
  newRegistrations: number;
  newPeople: number;
  mandals: MandalLine[];
  /** One row per person on an active registration, in registration order. */
  devotees: (string | number)[][];
}

export const DEVOTEE_HEADER = [
  "Reg. no.",
  "Person no.",
  "Name",
  "Gender",
  "Age",
  "Relation",
  "Mandal",
  "Mobile",
  "Arrives",
  "Leaves",
  "Travel",
  "Needs a bed",
  "Youth Convention",
  "Swayam Sevak",
  "Status",
  "Registered on (IST)",
];

const yesNo = (value: boolean | null | undefined) =>
  value === true ? "Yes" : value === false ? "No" : "";
const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const stayPoint = (point: { date: string; slot: string }) =>
  `${formatDay(point.date)}, ${point.slot}`;
/** Registrations saved before "pending" was retired still say it; read as registered (statusOf). */
const statusOf = (status: string) => (status === "pending" ? "confirmed" : status);

/** Every number in the report, from the registrations as stored. Pure, so it is tested without a database. */
export function summarise(all: ReportRegistration[], at: Date): DailyReport {
  const since = at.getTime() - 24 * 60 * 60 * 1000;
  const active = all
    .filter(r => statusOf(r.status) !== "cancelled")
    .sort((a, b) => a.sequence - b.sequence);
  const byMandal = new Map<string, MandalLine>();
  const devotees: (string | number)[][] = [];

  for (const r of active) {
    const isNew = r.createdAt.getTime() >= since;
    const line =
      byMandal.get(r.mandal) ??
      byMandal
        .set(r.mandal, {
          mandal: r.mandal,
          registrations: 0,
          people: 0,
          male: 0,
          female: 0,
          beds: 0,
          newPeople: 0,
        })
        .get(r.mandal)!;
    line.registrations += 1;
    for (const m of r.members) {
      line.people += 1;
      if (m.gender === "male") line.male += 1;
      if (m.gender === "female") line.female += 1;
      if (wantsBed(r, m)) line.beds += 1;
      if (isNew) line.newPeople += 1;

      // A party that does not all travel the same way has each person's own mode on them.
      const mode = r.travel.mode === "separate" ? (m.travel?.mode ?? "separate") : r.travel.mode;
      devotees.push([
        r.code,
        m.code ?? "",
        m.fullName,
        capitalise(m.gender),
        m.age,
        m.isPrimary ? "Contact" : (m.relation ?? ""),
        r.mandal,
        m.mobile ?? (m.isPrimary ? (r.contactMobile ?? "") : ""),
        stayPoint(m.arrival),
        stayPoint(m.departure),
        TRAVEL_LABELS[mode] ?? mode,
        wantsBed(r, m) ? "Yes" : "No",
        yesNo(m.attendsYouthConvention),
        isSevak(r, m) ? "Yes" : "",
        STATUS_LABELS[statusOf(r.status)] ?? r.status,
        sortableIst(r.createdAt),
      ]);
    }
  }

  const fresh = active.filter(r => r.createdAt.getTime() >= since);
  return {
    at,
    registrations: active.length,
    people: active.reduce((sum, r) => sum + r.members.length, 0),
    families: active.filter(r => r.type === "family").length,
    individuals: active.filter(r => r.type === "individual").length,
    checkedIn: active.filter(r => statusOf(r.status) === "checked_in").length,
    cancelled: all.length - active.length,
    newRegistrations: fresh.length,
    newPeople: fresh.reduce((sum, r) => sum + r.members.length, 0),
    mandals: [...byMandal.values()].sort(
      (a, b) => b.people - a.people || a.mandal.localeCompare(b.mandal)
    ),
    devotees,
  };
}

/** The template's {{1}}…{{4}}, in order. Meta refuses a value with a newline, so none has one. */
export function templateValues(report: DailyReport): string[] {
  return [
    formatIst(report.at),
    String(report.registrations),
    String(report.people),
    `${report.newPeople} ${report.newPeople === 1 ? "person" : "people"} in ${report.newRegistrations} ${
      report.newRegistrations === 1 ? "registration" : "registrations"
    }`,
  ];
}

export const reportFileName = (report: DailyReport) =>
  `registration-report-${istClock(report.at).date}.xlsx`;

/** Widest value in each column, in characters, within sensible bounds. */
const widths = (rows: (string | number)[][]) =>
  rows[0].map((_, column) => ({
    width: Math.min(40, Math.max(8, ...rows.map(row => String(row[column] ?? "").length + 2))),
  }));

/** Two sheets: the totals and the mandal table, then every devotee. */
export async function reportWorkbook(report: DailyReport): Promise<Buffer> {
  const bold = (value: string | number) => ({ value, fontWeight: "bold" as const });
  const mandalHeader = [
    "Mandal",
    "Registrations",
    "People",
    "Male",
    "Female",
    "Need a bed",
    "New people (24 h)",
  ];
  const mandalRows = report.mandals.map(line => [
    line.mandal,
    line.registrations,
    line.people,
    line.male,
    line.female,
    line.beds,
    line.newPeople,
  ]);
  const totals = [
    "Total",
    report.registrations,
    report.people,
    sum(report.mandals, "male"),
    sum(report.mandals, "female"),
    sum(report.mandals, "beds"),
    report.newPeople,
  ];

  const summary: Row[] = [
    [{ value: `${EVENT_NAME} — registration report`, fontWeight: "bold", fontSize: 14 }],
    [`As of ${formatIst(report.at)} (India time)`],
    [],
    [bold("Registrations"), report.registrations],
    ["  Families", report.families],
    ["  Individuals", report.individuals],
    [bold("People"), report.people],
    [
      "New in the last 24 hours",
      `${report.newPeople} people in ${report.newRegistrations} registrations`,
    ],
    ["Checked in", report.checkedIn],
    ["Cancelled (not counted above)", report.cancelled],
    [],
    mandalHeader.map(bold),
    ...mandalRows,
    totals.map(bold),
  ];

  return writeXlsxFile([
    {
      sheet: "Summary",
      data: summary,
      columns: [{ width: 30 }, ...widths([mandalHeader, ...mandalRows]).slice(1)],
    },
    {
      sheet: "Devotees",
      data: [DEVOTEE_HEADER.map(bold), ...report.devotees],
      columns: widths([DEVOTEE_HEADER, ...report.devotees]),
      stickyRowsCount: 1,
    },
  ]).toBuffer();
}

const sum = (lines: MandalLine[], key: "male" | "female" | "beds") =>
  lines.reduce((total, line) => total + line[key], 0);

/** Today's report from the database. Dummy data never appears in it. */
export async function buildDailyReport(at = new Date()) {
  const registrations = await prisma.registration.findMany({
    where: { isSample: false },
    select: {
      code: true,
      sequence: true,
      type: true,
      mandal: true,
      members: true,
      travel: true,
      accommodationRequired: true,
      earlySeva: true,
      status: true,
      contactMobile: true,
      createdAt: true,
    },
  });
  const report = summarise(registrations, at);
  return { report, bytes: await reportWorkbook(report), filename: reportFileName(report) };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendResult {
  to: string;
  waMessageId?: string;
  error?: string;
}

/**
 * Builds the report once, uploads it once, and sends it to each number. Never
 * throws for one person's failure: each result says what happened to whom.
 * Throws only when nothing can be sent at all (no WhatsApp, or the upload failed).
 */
export async function sendDailyReport(
  recipients: string[],
  purpose = DAILY_REPORT_PURPOSE,
  at = new Date()
): Promise<{ report: DailyReport; results: SendResult[] }> {
  const { report, bytes, filename } = await buildDailyReport(at);
  const mediaId = await uploadWhatsAppMedia({ bytes, filename, mimeType: XLSX_MIME });
  const body = templateValues(report);
  const results: SendResult[] = [];
  for (const to of recipients) {
    try {
      const { waMessageId } = await sendWhatsAppTemplate({
        to,
        template: WHATSAPP_TEMPLATES.dailyReport(),
        lang: "en",
        body,
        document: { id: mediaId, filename },
        usage: { endpoint: purpose },
        category: "UTILITY",
      });
      results.push({ to, waMessageId });
    } catch (error) {
      results.push({
        to,
        error: error instanceof WhatsAppSendError ? error.message : String(error),
      });
    }
  }
  return { report, results };
}

/** Who is still owed today's report: configured, not yet sent today, and not given up on. */
export function recipientsDue(
  recipients: string[],
  alreadySent: Set<string>,
  attempts: Map<string, number>,
  date: string
): string[] {
  return recipients.filter(
    to => !alreadySent.has(to) && (attempts.get(`${date}:${to}`) ?? 0) < MAX_ATTEMPTS_PER_DAY
  );
}

const attempts = new Map<string, number>();
/** Numbers sent to today in this process — in case the message log could not be written. */
const sentHere = new Set<string>();
let running: Promise<void> | null = null;

/** One check: if it is past the hour in India, send to whoever has not had today's report. */
export async function sendDailyReportIfDue(now = new Date()): Promise<void> {
  const { recipients, atMinutes } = dailyReportConfig();
  const { date, minutes, dayStart } = istClock(now);
  if (recipients.length === 0 || minutes < atMinutes) return;

  const logged = await prisma.whatsAppMessage.findMany({
    where: { purpose: DAILY_REPORT_PURPOSE, createdAt: { gte: dayStart } },
    select: { to: true },
  });
  const alreadySent = new Set(logged.map(row => row.to));
  for (const key of sentHere) if (key.startsWith(`${date}:`)) alreadySent.add(key.slice(11));
  const due = recipientsDue(recipients, alreadySent, attempts, date);
  if (due.length === 0) return;

  for (const to of due) attempts.set(`${date}:${to}`, (attempts.get(`${date}:${to}`) ?? 0) + 1);
  const { report, results } = await sendDailyReport(due, DAILY_REPORT_PURPOSE, now);
  for (const result of results) {
    if (result.waMessageId) sentHere.add(`${date}:${result.to}`);
    else console.error(`[Daily report] ${result.to}: ${result.error}`);
  }
  const sent = results.filter(result => result.waMessageId).length;
  console.log(
    `[Daily report] ${date}: sent to ${sent} of ${due.length} (${report.registrations} registrations, ${report.people} people).`
  );
}

/**
 * Starts the 4 pm report. On in production when `DAILY_REPORT_TO` has numbers;
 * `DAILY_REPORT_SCHEDULE=on|off` overrides, so a laptop with production's env
 * does not send a second copy.
 */
export function startDailyReportSchedule() {
  const setting = process.env.DAILY_REPORT_SCHEDULE?.trim().toLowerCase();
  const enabled = setting ? setting === "on" : process.env.NODE_ENV === "production";
  if (!enabled) return;

  const { recipients, atMinutes } = dailyReportConfig();
  if (recipients.length === 0) return;
  if (!isWhatsAppConfigured()) {
    console.warn(
      "[Daily report] WhatsApp is not configured (WA_* env), so no daily report will be sent."
    );
    return;
  }

  const check = () => {
    if (running) return;
    running = sendDailyReportIfDue()
      .catch(error => console.error("[Daily report] Failed:", error))
      .finally(() => {
        running = null;
      });
  };
  // unref: a pending check must never be what keeps a shutting-down process alive.
  setTimeout(check, FIRST_CHECK_AFTER_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  const at = `${String(Math.floor(atMinutes / 60)).padStart(2, "0")}:${String(atMinutes % 60).padStart(2, "0")}`;
  console.log(`[Daily report] Daily at ${at} IST to ${recipients.length} number(s).`);
}
