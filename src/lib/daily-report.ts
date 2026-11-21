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
 * The daily reports: Excel workbooks sent on WhatsApp at a set time in India, each
 * to its own list of numbers (owner's requests, 2026-11-21). Two kinds (`REPORTS`):
 *
 * - **registrations** — everyone registered; template `daily_registration_report`;
 *   `DAILY_REPORT_TO` at `DAILY_REPORT_AT` (default 16:00).
 * - **youth** — only devotees who said they will attend the Youth Convention;
 *   template `daily_youth_convention_registrations_report`; `YC_REPORT_TO` at
 *   `YC_REPORT_AT`, each falling back to the registration report's when empty.
 *
 * Both share the layout, the schedule and the send; only who is in it, the
 * columns, the titles and the template differ.
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
export const YOUTH_REPORT_PURPOSE = "whatsapp:daily_youth_report";
export const YOUTH_REPORT_TEST_PURPOSE = "whatsapp:daily_youth_report_test";

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
 * `DAILY_REPORT_TO` / `YC_REPORT_TO`: numbers separated by commas, any common form
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
      console.warn(`[Daily report] Skipping "${raw.trim()}": not a phone number.`);
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

/** The Youth Convention report's: its own settings, or the registration report's when empty. */
export function youthReportConfig(): DailyReportConfig {
  const to = process.env.YC_REPORT_TO?.trim() || process.env.DAILY_REPORT_TO;
  const at = process.env.YC_REPORT_AT?.trim() || process.env.DAILY_REPORT_AT;
  return { recipients: parseRecipients(to), atMinutes: parseReportTime(at) };
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
type ReportMember = ReportRegistration["members"][number];

/** The numbers the registration report's message carries. */
export interface DailyReport {
  at: Date;
  registrations: number;
  people: number;
  newRegistrations: number;
  newPeople: number;
}

/** Registrations saved before "pending" was retired still say it; read as registered (statusOf). */
const isActive = (r: Pick<Registration, "status">) => r.status !== "cancelled";
const attendsYouth = (m: ReportMember) => m.attendsYouthConvention === true;

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

/** The registration template's {{1}}…{{4}}, in order. Meta refuses a value with a newline. */
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

/**
 * The Youth Convention template's {{1}}…{{3}}: when, how many said they will
 * attend, and how many of those were registered in the 24 hours before.
 */
export function youthTemplateValues(all: ReportRegistration[], at: Date): string[] {
  const since = at.getTime() - 24 * 60 * 60 * 1000;
  let attending = 0;
  let fresh = 0;
  for (const r of all.filter(isActive)) {
    const n = r.members.filter(attendsYouth).length;
    attending += n;
    if (r.createdAt.getTime() >= since) fresh += n;
  }
  return [formatIst(at), String(attending), `${fresh} ${fresh === 1 ? "devotee" : "devotees"}`];
}

export const reportFileName = (report: DailyReport) =>
  `registration-report-${istClock(report.at).date}.xlsx`;

/*
 * Each workbook is laid out exactly as the export the team was already using
 * (owner's request, 2026-11-21: "it should look exactly like this"):
 * "Dashabdi Mahotsav - Registrations.xlsx" for the registration report and
 * "Youth Convention - Registered Devotees.xlsx" for the Youth Convention one,
 * both made by one-off scripts on 2026-11-19. Same sheets ("Devotees by mandal"
 * with a band per mandal, biggest first; "Mandal totals"; one sheet per
 * mandal), columns, widths, colours and wording — built from the live
 * database at each send. Change them only if the team asks for its export to change.
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

/**
 * The people on active registrations that `include` keeps (everyone, by
 * default), ordered by mandal, registration, then the contact first.
 */
export function devoteeRows(
  all: ReportRegistration[],
  include: (m: ReportMember) => boolean = () => true
): DevoteeRow[] {
  const people = all.filter(isActive).flatMap(r => {
    const contact = r.members.find(m => m.isPrimary) ?? r.members[0];
    return r.members.filter(include).map(m => ({ r, m, contact }));
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

type Column = [header: string, key: keyof DevoteeRow, width: number];
const ALL_COLUMNS: Column[] = [
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
/** Everyone in it said yes, so the Youth Convention export has no column saying so. */
const YOUTH_COLUMNS = ALL_COLUMNS.filter(([, key]) => key !== "yc");

/** What differs between the two workbooks. */
interface WorkbookLayout {
  columns: Column[];
  /** Line 1 of "Devotees by mandal", given how many people are in it. */
  title: (count: number) => string;
  /** Line 2 of "Devotees by mandal", given the day ("21 Nov 2026"). */
  note: (asOf: string) => string;
  /** Lines 1 and 2 of "Mandal totals". */
  totalsTitle: string;
  totalsNote: (asOf: string) => string;
  /** The registration export counts registrations too; the Youth Convention one only people. */
  countRegistrations: boolean;
  totalLabel: string;
}

const REGISTRATIONS_LAYOUT: WorkbookLayout = {
  columns: ALL_COLUMNS,
  title: n => `${EVENT_NAME} — all registered devotees: ${n}`,
  note: asOf =>
    `Every registration (cancelled and dummy ones left out), grouped by mandal. From the live registration database on ${asOf}.`,
  totalsTitle: `${EVENT_NAME} — all registered devotees`,
  totalsNote: asOf =>
    `Every registration (cancelled and dummy ones left out). From the live registration database on ${asOf}.`,
  countRegistrations: true,
  totalLabel: "Total devotees",
};

const YOUTH_LAYOUT: WorkbookLayout = {
  columns: YOUTH_COLUMNS,
  title: n => `Youth Convention — devotees attending: ${n}`,
  note: asOf => `Grouped by mandal. From the live registration database on ${asOf}.`,
  totalsTitle: "Youth Convention — devotees attending",
  totalsNote: asOf => `From the live registration database on ${asOf}.`,
  countRegistrations: false,
  totalLabel: "Total devotees attending",
};

/** Excel refuses \ / ? * [ ] : in a sheet name, and more than 31 characters. */
const sheetName = (name: string) => name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);

/** The three kinds of sheet, for the people given, in the layout given. */
async function workbook(everyone: DevoteeRow[], layout: WorkbookLayout, at: Date): Promise<Buffer> {
  const { columns } = layout;
  const widths = columns.map(([, , width]) => ({ width }));
  const headerRow = (): Row => columns.map(([header]) => ({ value: header, ...HEADER_STYLE }));
  const devoteeRow = (row: DevoteeRow): Row =>
    columns.map(([, key]) => {
      const value = row[key];
      if (value === "") return null;
      return typeof value === "number" ? { value, type: Number } : { value, type: String };
    });
  /** A cell spanning the whole table, then the empty cells it covers. */
  const spanRow = (cell: Record<string, unknown>): Row => [
    { ...cell, columnSpan: columns.length } as Row[number],
    ...columns.slice(1).map(() => null),
  ];
  const asOf = longDay(istClock(at).date);

  // By mandal, biggest first; Sr starts again at 1 in each.
  const byMandal = new Map<string, DevoteeRow[]>();
  for (const row of everyone) byMandal.set(row.mandal, [...(byMandal.get(row.mandal) ?? []), row]);
  const groups = [...byMandal.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([mandal, rows]) => [mandal, rows.map((row, i) => ({ ...row, sr: i + 1 }))] as const);

  const grouped: Row[] = [
    spanRow({ value: layout.title(everyone.length), fontWeight: "bold", fontSize: 14 }),
    spanRow({ value: layout.note(asOf) }),
  ];
  for (const [mandal, rows] of groups) {
    grouped.push(columns.map(() => null));
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
  // The registration export has a Registrations column between Mandal and Devotees.
  const line = (label: Row[number], rows: DevoteeRow[], isBold = false): Row =>
    layout.countRegistrations
      ? [label, count(registrationsIn(rows), isBold), count(rows.length, isBold)]
      : [label, count(rows.length, isBold)];
  const empty = (): Row => (layout.countRegistrations ? [null, null, null] : [null, null]);
  const pad = (cell: Row[number]): Row => [cell, ...empty().slice(1)];
  const totals: Row[] = [
    pad({ value: layout.totalsTitle, fontWeight: "bold", fontSize: 14 }),
    pad({ value: layout.totalsNote(asOf) }),
    empty(),
    ...(layout.countRegistrations
      ? [[bold("Total registrations"), count(registrationsIn(everyone), true), null] as Row]
      : []),
    layout.countRegistrations
      ? [bold(layout.totalLabel), count(everyone.length, true), null]
      : [bold(layout.totalLabel), count(everyone.length, true)],
    empty(),
    [
      { value: "Mandal", ...HEADER_STYLE },
      ...(layout.countRegistrations ? [{ value: "Registrations", ...HEADER_STYLE }] : []),
      { value: "Devotees", ...HEADER_STYLE },
    ],
    ...groups.map(([mandal, rows]) => line({ value: mandal }, rows)),
    line(bold("Total"), everyone, true),
  ];

  return writeXlsxFile([
    { sheet: "Devotees by mandal", data: grouped, columns: widths },
    {
      sheet: "Mandal totals",
      data: totals,
      columns: layout.countRegistrations
        ? [{ width: 40 }, { width: 14 }, { width: 10 }]
        : [{ width: 40 }, { width: 10 }],
    },
    ...groups.map(([mandal, rows]) => ({
      sheet: sheetName(mandal),
      data: [headerRow(), ...rows.map(devoteeRow)],
      columns: widths,
      stickyRowsCount: 1,
    })),
  ]).toBuffer();
}

/** The registration report's workbook. */
export const reportWorkbook = (all: ReportRegistration[], at: Date) =>
  workbook(devoteeRows(all), REGISTRATIONS_LAYOUT, at);

/** The Youth Convention report's workbook: only devotees who said they will attend. */
export const youthWorkbook = (all: ReportRegistration[], at: Date) =>
  workbook(devoteeRows(all, attendsYouth), YOUTH_LAYOUT, at);

/** Every registration but dummy data, as both reports read them. */
const loadRegistrations = () =>
  prisma.registration.findMany({
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

/** Today's registration report from the database. */
export async function buildDailyReport(at = new Date()) {
  const registrations = await loadRegistrations();
  const report = summarise(registrations, at);
  return {
    report,
    bytes: await reportWorkbook(registrations, at),
    filename: reportFileName(report),
  };
}

// ---------------------------------------------------------------------------
// The two reports
// ---------------------------------------------------------------------------

/** A built report: the file, its name, and the template's values. */
export interface BuiltReport {
  bytes: Buffer;
  filename: string;
  values: string[];
  /** For the log line. */
  summary: string;
}

export interface ReportKind {
  name: string;
  purpose: string;
  testPurpose: string;
  template: () => string;
  config: () => DailyReportConfig;
  build: (at: Date) => Promise<BuiltReport>;
}

export const REGISTRATION_REPORT: ReportKind = {
  name: "Registration report",
  purpose: DAILY_REPORT_PURPOSE,
  testPurpose: DAILY_REPORT_TEST_PURPOSE,
  template: () => WHATSAPP_TEMPLATES.dailyReport(),
  config: dailyReportConfig,
  build: async at => {
    const { report, bytes, filename } = await buildDailyReport(at);
    return {
      bytes,
      filename,
      values: templateValues(report),
      summary: `${report.registrations} registrations, ${report.people} people`,
    };
  },
};

export const YOUTH_REPORT: ReportKind = {
  name: "Youth Convention report",
  purpose: YOUTH_REPORT_PURPOSE,
  testPurpose: YOUTH_REPORT_TEST_PURPOSE,
  template: () => WHATSAPP_TEMPLATES.youthReport(),
  config: youthReportConfig,
  build: async at => {
    const registrations = await loadRegistrations();
    const values = youthTemplateValues(registrations, at);
    return {
      bytes: await youthWorkbook(registrations, at),
      filename: `youth-convention-report-${istClock(at).date}.xlsx`,
      values,
      summary: `${values[1]} attending`,
    };
  },
};

export const REPORTS = [REGISTRATION_REPORT, YOUTH_REPORT];

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendResult {
  to: string;
  waMessageId?: string;
  error?: string;
}

/**
 * Builds a report once, uploads it once, and sends it to each number. Never
 * throws for one person's failure: each result says what happened to whom.
 * Throws only when nothing can be sent at all (no WhatsApp, or the upload failed).
 */
export async function sendReport(
  kind: ReportKind,
  recipients: string[],
  purpose = kind.purpose,
  at = new Date()
): Promise<{ report: BuiltReport; results: SendResult[] }> {
  const report = await kind.build(at);
  const mediaId = await uploadWhatsAppMedia({
    bytes: report.bytes,
    filename: report.filename,
    mimeType: XLSX_MIME,
  });
  const results: SendResult[] = [];
  for (const to of recipients) {
    try {
      const { waMessageId } = await sendWhatsAppTemplate({
        to,
        template: kind.template(),
        lang: "en",
        body: report.values,
        document: { id: mediaId, filename: report.filename },
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
  key: string
): string[] {
  return recipients.filter(
    to => !alreadySent.has(to) && (attempts.get(`${key}:${to}`) ?? 0) < MAX_ATTEMPTS_PER_DAY
  );
}

/** Keyed `<purpose>:<IST date>:<number>`. */
const attempts = new Map<string, number>();
/** Numbers sent to today in this process — in case the message log could not be written. */
const sentHere = new Set<string>();
let running: Promise<void> | null = null;

/** One check for one report: if it is past its hour in India, send to whoever has not had today's. */
export async function sendReportIfDue(kind: ReportKind, now = new Date()): Promise<void> {
  const { recipients, atMinutes } = kind.config();
  const { date, minutes, dayStart } = istClock(now);
  if (recipients.length === 0 || minutes < atMinutes) return;

  const key = `${kind.purpose}:${date}`;
  const logged = await prisma.whatsAppMessage.findMany({
    where: { purpose: kind.purpose, createdAt: { gte: dayStart } },
    select: { to: true },
  });
  const alreadySent = new Set(logged.map(row => row.to));
  for (const to of recipients) if (sentHere.has(`${key}:${to}`)) alreadySent.add(to);
  const due = recipientsDue(recipients, alreadySent, attempts, key);
  if (due.length === 0) return;

  for (const to of due) attempts.set(`${key}:${to}`, (attempts.get(`${key}:${to}`) ?? 0) + 1);
  const { report, results } = await sendReport(kind, due, kind.purpose, now);
  for (const result of results) {
    if (result.waMessageId) sentHere.add(`${key}:${result.to}`);
    else console.error(`[Daily report] ${kind.name}, ${result.to}: ${result.error}`);
  }
  const sent = results.filter(result => result.waMessageId).length;
  console.log(
    `[Daily report] ${kind.name} ${date}: sent to ${sent} of ${due.length} (${report.summary}).`
  );
}

/** The registration report's check — kept by name for the tests and the script. */
export const sendDailyReportIfDue = (now = new Date()) => sendReportIfDue(REGISTRATION_REPORT, now);

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Starts both reports. On in production when a report has numbers;
 * `DAILY_REPORT_SCHEDULE=on|off` overrides for both, so a laptop with
 * production's env does not send a second copy.
 */
export function startDailyReportSchedule() {
  const setting = process.env.DAILY_REPORT_SCHEDULE?.trim().toLowerCase();
  const enabled = setting ? setting === "on" : process.env.NODE_ENV === "production";
  if (!enabled) return;

  const active = REPORTS.filter(kind => kind.config().recipients.length > 0);
  if (active.length === 0) return;
  if (!isWhatsAppConfigured()) {
    console.warn(
      "[Daily report] WhatsApp is not configured (WA_* env), so no daily report will be sent."
    );
    return;
  }

  // One report after the other, never two uploads at once; a failure in one does not stop the other.
  const check = () => {
    if (running) return;
    running = (async () => {
      for (const kind of active) {
        await sendReportIfDue(kind).catch(error =>
          console.error(`[Daily report] ${kind.name} failed:`, error)
        );
      }
    })().finally(() => {
      running = null;
    });
  };
  // unref: a pending check must never be what keeps a shutting-down process alive.
  setTimeout(check, FIRST_CHECK_AFTER_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  for (const kind of active) {
    const { recipients, atMinutes } = kind.config();
    console.log(
      `[Daily report] ${kind.name}: daily at ${hhmm(atMinutes)} IST to ${recipients.length} number(s).`
    );
  }
}
