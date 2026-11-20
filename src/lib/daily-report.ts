import type { Registration } from "@prisma/client";
import writeXlsxFile, { type Row } from "write-excel-file/node";

import { prisma } from "../utils/db";
import { EVENT_NAME } from "./event";
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

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

type ReportRegistration = Pick<
  Registration,
  | "code"
  | "sequence"
  | "type"
  | "groupName"
  | "mandal"
  | "members"
  | "accommodationRequired"
  | "earlySeva"
  | "status"
  | "contactMobile"
  | "createdAt"
>;

/** The numbers the WhatsApp message itself carries. */
export interface DailyReport {
  at: Date;
  registrations: number;
  people: number;
  newRegistrations: number;
  newPeople: number;
}

/** Registrations saved before "pending" was retired still say it; read as registered (statusOf). */
const isActive = (r: Pick<Registration, "status">) => r.status !== "cancelled";

/** The message's numbers. Cancelled registrations are left out, as everywhere in the report. */
export function summarise(all: ReportRegistration[], at: Date): DailyReport {
  const since = at.getTime() - 24 * 60 * 60 * 1000;
  const active = all.filter(isActive);
  const fresh = active.filter(r => r.createdAt.getTime() >= since);
  const people = (list: ReportRegistration[]) => list.reduce((n, r) => n + r.members.length, 0);
  return {
    at,
    registrations: active.length,
    people: people(active),
    newRegistrations: fresh.length,
    newPeople: people(fresh),
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

/*
 * The workbook is laid out exactly as "Dashabdi Mahotsav - Registrations.xlsx",
 * the export the team was already using (owner's request, 2026-11-21: "it
 * should look exactly like this"). That file was made by a one-off script on
 * 2026-11-19; this is the same layout, built from the live database at each
 * send: "Devotees by mandal" (everyone, a band per mandal, biggest first),
 * "Mandal totals", then one sheet per mandal. Same 19 columns, widths, colours
 * and wording — change them here only if the team asks for the export to change.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2027-01-29" → "29 Jan 2027". */
const longDay = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : "";
};
const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined ? "" : value ? "Yes" : "No";
const capitalise = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : "");
/** "29 Jan 2027 Morning". */
const stayPoint = (point: { date: string; slot: string } | null | undefined) =>
  point ? `${longDay(point.date)} ${capitalise(point.slot)}`.trim() : "";

interface DevoteeRow {
  sr: number;
  code: string;
  regCode: string;
  name: string;
  gender: string;
  age: number;
  mobile: string;
  mandal: string;
  type: string;
  family: string;
  relation: string;
  contactName: string;
  contactMobile: string;
  arrival: string;
  departure: string;
  stay: string;
  seva: string;
  yc: string;
  registered: string;
}

/** Everyone on an active registration, ordered by mandal, registration, then the contact first. */
export function devoteeRows(all: ReportRegistration[]): DevoteeRow[] {
  const people = all.filter(isActive).flatMap(r => {
    const contact = r.members.find(m => m.isPrimary) ?? r.members[0];
    return r.members.map(m => ({ r, m, contact }));
  });
  people.sort(
    (a, b) =>
      (a.r.mandal < b.r.mandal ? -1 : a.r.mandal > b.r.mandal ? 1 : 0) ||
      a.r.sequence - b.r.sequence ||
      (a.m.isPrimary ? 0 : 1) - (b.m.isPrimary ? 0 : 1)
  );
  return people.map(({ r, m, contact }, i) => ({
    sr: i + 1,
    code: m.code ?? "",
    regCode: r.code,
    name: m.fullName,
    gender: m.gender === "male" ? "Male" : m.gender === "female" ? "Female" : m.gender,
    age: m.age,
    mobile: m.mobile ?? "",
    mandal: r.mandal,
    type: r.type === "family" ? "Family" : "Individual",
    family: r.groupName ?? "",
    relation: m.isPrimary ? "Primary contact" : (m.relation ?? ""),
    contactName: contact?.fullName ?? "",
    contactMobile: r.contactMobile ?? contact?.mobile ?? "",
    arrival: stayPoint(m.arrival),
    departure: stayPoint(m.departure),
    stay: yesNo(m.needsAccommodation ?? r.accommodationRequired),
    seva: yesNo(m.earlySeva ?? r.earlySeva),
    yc: yesNo(m.attendsYouthConvention),
    // The day in India, not UTC: a registration at 1 am IST belongs to that day.
    registered: longDay(istClock(r.createdAt).date),
  }));
}

const HEADER_STYLE = { fontWeight: "bold" as const, backgroundColor: "#E8EEF7" };

const COLUMNS: [header: string, key: keyof DevoteeRow, width: number][] = [
  ["Sr", "sr", 5],
  ["Person no.", "code", 11],
  ["Registration no.", "regCode", 15],
  ["Full name", "name", 30],
  ["Gender", "gender", 8],
  ["Age", "age", 6],
  ["Mobile", "mobile", 15],
  ["Mandal", "mandal", 18],
  ["Type", "type", 11],
  ["Family name", "family", 18],
  ["Relation", "relation", 15],
  ["Primary contact", "contactName", 28],
  ["Contact mobile", "contactMobile", 15],
  ["Arrival", "arrival", 22],
  ["Departure", "departure", 22],
  ["Accommodation", "stay", 14],
  ["Early seva", "seva", 10],
  ["Youth Convention", "yc", 16],
  ["Registered on", "registered", 14],
];
const COLUMN_WIDTHS = COLUMNS.map(([, , width]) => ({ width }));

const headerRow = (): Row => COLUMNS.map(([header]) => ({ value: header, ...HEADER_STYLE }));
const devoteeRow = (row: DevoteeRow): Row =>
  COLUMNS.map(([, key]) => {
    const value = row[key];
    if (value === "") return null;
    return typeof value === "number" ? { value, type: Number } : { value, type: String };
  });
/** A cell spanning the whole table, then the empty cells it covers. */
const spanRow = (cell: Record<string, unknown>): Row => [
  { ...cell, columnSpan: COLUMNS.length } as Row[number],
  ...COLUMNS.slice(1).map(() => null),
];
/** Excel refuses \ / ? * [ ] : in a sheet name, and more than 31 characters. */
const sheetName = (name: string) => name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);

/** The three kinds of sheet, from the registrations as stored. */
export async function reportWorkbook(all: ReportRegistration[], at: Date): Promise<Buffer> {
  const everyone = devoteeRows(all);
  const asOf = longDay(istClock(at).date);

  // By mandal, biggest first; Sr starts again at 1 in each.
  const byMandal = new Map<string, DevoteeRow[]>();
  for (const row of everyone) byMandal.set(row.mandal, [...(byMandal.get(row.mandal) ?? []), row]);
  const groups = [...byMandal.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([mandal, rows]) => [mandal, rows.map((row, i) => ({ ...row, sr: i + 1 }))] as const);

  const grouped: Row[] = [
    spanRow({
      value: `${EVENT_NAME} — all registered devotees: ${everyone.length}`,
      fontWeight: "bold",
      fontSize: 14,
    }),
    spanRow({
      value: `Every registration (cancelled and dummy ones left out), grouped by mandal. From the live registration database on ${asOf}.`,
    }),
  ];
  for (const [mandal, rows] of groups) {
    grouped.push(COLUMNS.map(() => null));
    grouped.push(
      spanRow({
        value: `${mandal} — ${rows.length} ${rows.length === 1 ? "devotee" : "devotees"}`,
        fontWeight: "bold",
        fontSize: 12,
        backgroundColor: "#FCE9C8",
      })
    );
    grouped.push(headerRow());
    for (const row of rows) grouped.push(devoteeRow(row));
  }

  const registrationsIn = (rows: DevoteeRow[]) => new Set(rows.map(row => row.regCode)).size;
  const bold = (value: string) => ({ value, fontWeight: "bold" as const });
  const count = (value: number, isBold = false) => ({
    value,
    type: Number,
    ...(isBold ? { fontWeight: "bold" as const } : {}),
  });
  const totals: Row[] = [
    [
      { value: `${EVENT_NAME} — all registered devotees`, fontWeight: "bold", fontSize: 14 },
      null,
      null,
    ],
    [
      {
        value: `Every registration (cancelled and dummy ones left out). From the live registration database on ${asOf}.`,
      },
      null,
      null,
    ],
    [null, null, null],
    [bold("Total registrations"), count(registrationsIn(everyone), true), null],
    [bold("Total devotees"), count(everyone.length, true), null],
    [null, null, null],
    [
      { value: "Mandal", ...HEADER_STYLE },
      { value: "Registrations", ...HEADER_STYLE },
      { value: "Devotees", ...HEADER_STYLE },
    ],
    ...groups.map(([mandal, rows]): Row => [
      { value: mandal },
      count(registrationsIn(rows)),
      count(rows.length),
    ]),
    [bold("Total"), count(registrationsIn(everyone), true), count(everyone.length, true)],
  ];

  return writeXlsxFile([
    { sheet: "Devotees by mandal", data: grouped, columns: COLUMN_WIDTHS },
    {
      sheet: "Mandal totals",
      data: totals,
      columns: [{ width: 40 }, { width: 14 }, { width: 10 }],
    },
    ...groups.map(([mandal, rows]) => ({
      sheet: sheetName(mandal),
      data: [headerRow(), ...rows.map(devoteeRow)],
      columns: COLUMN_WIDTHS,
      stickyRowsCount: 1,
    })),
  ]).toBuffer();
}

/** Today's report from the database. Dummy data never appears in it. */
export async function buildDailyReport(at = new Date()) {
  const registrations = await prisma.registration.findMany({
    where: { isSample: false },
    select: {
      code: true,
      sequence: true,
      type: true,
      groupName: true,
      mandal: true,
      members: true,
      accommodationRequired: true,
      earlySeva: true,
      status: true,
      contactMobile: true,
      createdAt: true,
    },
  });
  const report = summarise(registrations, at);
  return {
    report,
    bytes: await reportWorkbook(registrations, at),
    filename: reportFileName(report),
  };
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
