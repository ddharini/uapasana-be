/**
 * The daily report is read by the team as the day's numbers, and every send is
 * a paid message: these pin what is counted (cancelled and dummy data never),
 * when it is due (4 pm India time, once a day per person), and that the
 * template gets exactly its four values and the document header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  registration: { findMany: vi.fn() },
  whatsAppMessage: { findMany: vi.fn() },
}));
vi.mock("../utils/db", () => ({ prisma: db }));

const wa = vi.hoisted(() => ({
  sendWhatsAppTemplate: vi.fn(),
  uploadWhatsAppMedia: vi.fn(),
}));
vi.mock("./whatsapp", async importOriginal => ({
  ...(await importOriginal<typeof import("./whatsapp")>()),
  ...wa,
}));

import {
  DAILY_REPORT_PURPOSE,
  YOUTH_REPORT,
  YOUTH_REPORT_PURPOSE,
  sendReportIfDue,
  youthReportConfig,
  youthTemplateValues,
  youthWorkbook,
  devoteeRows,
  istClock,
  parseRecipients,
  parseReportTime,
  recipientsDue,
  reportWorkbook,
  sendDailyReportIfDue,
  summarise,
  templateValues,
} from "./daily-report";
import { templateComponents } from "./whatsapp";

const at = new Date("2026-11-21T10:30:00Z"); // 4:00 pm IST

const person = (extra: object = {}) => ({
  id: "m1",
  code: "DM-0001",
  fullName: "Harit Patel",
  gender: "male",
  age: 30,
  mobile: null,
  relation: null,
  isPrimary: true,
  needsAssistance: false,
  attendsYouthConvention: true,
  arrival: { date: "2027-01-29", slot: "morning", meal: null },
  departure: { date: "2027-02-01", slot: "evening", meal: null },
  needsAccommodation: null,
  earlySeva: null,
  travel: null,
  indiaTravel: null,
  ...extra,
});

let sequence = 0;
const registration = (extra: object = {}) =>
  ({
    code: `DM-F-${++sequence}`,
    sequence,
    type: "family",
    mandal: "Surat",
    members: [person()],
    travel: { mode: "train" },
    accommodationRequired: true,
    earlySeva: null,
    status: "confirmed",
    contactMobile: "+919876543210",
    createdAt: new Date("2026-11-10T00:00:00Z"),
    ...extra,
  }) as never;

describe("parseReportTime", () => {
  it("reads HH:MM and falls back to 4 pm", () => {
    expect(parseReportTime("16:00")).toBe(960);
    expect(parseReportTime("9:30")).toBe(570);
    expect(parseReportTime(undefined)).toBe(960);
    expect(parseReportTime("25:00")).toBe(960);
    expect(parseReportTime("4pm")).toBe(960);
  });
});

describe("parseRecipients", () => {
  it("accepts common forms, keeps spaces inside a number, de-duplicates and skips junk", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseRecipients("+91 98765 43210, 9876543210; 09812345678,\n abc")).toEqual([
      "919876543210",
      "919812345678",
    ]);
    expect(parseRecipients(undefined)).toEqual([]);
  });
});

describe("istClock", () => {
  it("is India's calendar day and time, whatever the server's zone", () => {
    expect(istClock(at)).toEqual({
      date: "2026-11-21",
      minutes: 960,
      dayStart: new Date("2026-11-20T18:30:00Z"),
    });
    // 11:00 pm UTC is already the next morning in India.
    expect(istClock(new Date("2026-11-21T23:00:00Z")).date).toBe("2026-11-22");
  });
});

describe("summarise", () => {
  it("leaves cancelled out of the message's numbers", () => {
    const report = summarise(
      [
        registration({
          members: [person(), person({ id: "m2", gender: "female", isPrimary: false })],
        }),
        registration({ status: "cancelled" }),
        registration({ mandal: "Vadodara", type: "individual", status: "checked_in" }),
      ],
      at
    );
    expect(report).toMatchObject({ registrations: 2, people: 3 });
  });

  it("counts as new only what was registered in the 24 hours before", () => {
    const report = summarise(
      [
        registration({
          createdAt: new Date("2026-11-21T09:00:00Z"),
          members: [person(), person()],
        }),
        registration({ createdAt: new Date("2026-11-20T10:29:00Z") }),
      ],
      at
    );
    expect([report.newRegistrations, report.newPeople]).toEqual([1, 2]);
  });
});

describe("devoteeRows", () => {
  it("has the 19 columns of the team's export, in its order and wording", () => {
    const [row] = devoteeRows([
      registration({
        code: "DM-F-0143",
        groupName: "Pandya family",
        createdAt: new Date("2026-10-27T19:00:00Z"), // 28 Oct in India
        members: [person({ code: "DM-0239", fullName: "Sunil Pandya", age: 65 })],
      }),
    ]);
    expect(row).toEqual({
      sr: 1,
      code: "DM-0239",
      regCode: "DM-F-0143",
      name: "Sunil Pandya",
      gender: "Male",
      age: 65,
      mobile: "",
      mandal: "Surat",
      type: "Family",
      family: "Pandya family",
      relation: "Primary contact",
      contactName: "Sunil Pandya",
      contactMobile: "+919876543210",
      arrival: "29 Jan 2027 Morning",
      departure: "1 Feb 2027 Evening",
      stay: "Yes",
      seva: "",
      yc: "Yes",
      registered: "28 Oct 2026",
    });
  });

  it("drops cancelled, and orders by mandal, registration, then the contact first", () => {
    const rows = devoteeRows([
      registration({ mandal: "Vadodara", sequence: 1 }),
      registration({
        mandal: "Surat",
        sequence: 5,
        members: [
          person({ fullName: "Child", isPrimary: false, relation: "Son" }),
          person({ fullName: "Parent" }),
        ],
      }),
      registration({ mandal: "Anand", status: "cancelled" }),
    ]);
    expect(rows.map(r => [r.mandal, r.name, r.relation, r.contactName])).toEqual([
      ["Surat", "Parent", "Primary contact", "Parent"],
      ["Surat", "Child", "Son", "Parent"],
      ["Vadodara", "Harit Patel", "Primary contact", "Harit Patel"],
    ]);
  });
});

describe("templateValues", () => {
  it("gives the four values in order, none with a newline", () => {
    const values = templateValues(
      summarise([registration({ createdAt: new Date("2026-11-21T09:00:00Z") })], at)
    );
    expect(values).toEqual(["21 Nov 2026, 4:00 pm", "1", "1", "1 person in 1 registration"]);
    expect(values.join("")).not.toMatch(/\n/);
  });
});

describe("templateComponents with a document", () => {
  it("puts the header first, with the filename the reader sees", () => {
    expect(templateComponents(["a"], undefined, { id: "123", filename: "r.xlsx" })).toEqual([
      {
        type: "header",
        parameters: [{ type: "document", document: { id: "123", filename: "r.xlsx" } }],
      },
      { type: "body", parameters: [{ type: "text", text: "a" }] },
    ]);
  });
});

describe("reportWorkbook", () => {
  it("is an .xlsx file", async () => {
    const bytes = await reportWorkbook([registration()], at);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });
});

describe("recipientsDue", () => {
  it("skips who has had today's report and who has failed three times today", () => {
    const attempts = new Map([["2026-11-21:9198", 3]]);
    expect(
      recipientsDue(["9197", "9198", "9199"], new Set(["9197"]), attempts, "2026-11-21")
    ).toEqual(["9199"]);
  });
});

describe("sendDailyReportIfDue", () => {
  beforeEach(() => {
    process.env.DAILY_REPORT_TO = "+919811111111, +919822222222";
    delete process.env.DAILY_REPORT_AT;
    db.registration.findMany.mockResolvedValue([registration()]);
    wa.uploadWhatsAppMedia.mockResolvedValue("media-1");
    wa.sendWhatsAppTemplate.mockResolvedValue({ waMessageId: "wamid.1" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.DAILY_REPORT_TO;
    vi.clearAllMocks();
  });

  it("sends nothing before 4 pm India time", async () => {
    await sendDailyReportIfDue(new Date("2026-11-21T10:29:00Z"));
    expect(db.whatsAppMessage.findMany).not.toHaveBeenCalled();
    expect(wa.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("after 4 pm, uploads once and sends only to who has not had today's report", async () => {
    db.whatsAppMessage.findMany.mockResolvedValue([{ to: "919811111111" }]);
    await sendDailyReportIfDue(at);

    expect(db.whatsAppMessage.findMany).toHaveBeenCalledWith({
      where: {
        purpose: DAILY_REPORT_PURPOSE,
        createdAt: { gte: new Date("2026-11-20T18:30:00Z") },
      },
      select: { to: true },
    });
    expect(wa.uploadWhatsAppMedia).toHaveBeenCalledTimes(1);
    expect(wa.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(wa.sendWhatsAppTemplate.mock.calls[0][0]).toMatchObject({
      to: "919822222222",
      template: "daily_registration_report",
      document: { id: "media-1", filename: "registration-report-2026-11-21.xlsx" },
      usage: { endpoint: DAILY_REPORT_PURPOSE },
    });
  });

  it("does not send twice in a day even if the message log was not written", async () => {
    db.whatsAppMessage.findMany.mockResolvedValue([]);
    const later = new Date("2026-11-22T10:35:00Z");
    await sendDailyReportIfDue(later);
    expect(wa.sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
    await sendDailyReportIfDue(new Date(later.getTime() + 5 * 60 * 1000));
    expect(wa.sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
  });
});

describe("the Youth Convention report", () => {
  const yc = [
    registration({
      createdAt: new Date("2026-11-21T09:00:00Z"),
      members: [
        person({ fullName: "Yes", attendsYouthConvention: true }),
        person({ fullName: "No", attendsYouthConvention: false, isPrimary: false }),
        person({ fullName: "Unasked", attendsYouthConvention: null, isPrimary: false }),
      ],
    }),
    registration({ members: [person({ fullName: "Older yes", attendsYouthConvention: true })] }),
    registration({ status: "cancelled", members: [person({ attendsYouthConvention: true })] }),
  ];

  it("lists only those who said yes, from active registrations", () => {
    expect(devoteeRows(yc, m => m.attendsYouthConvention === true).map(r => r.name)).toEqual([
      "Yes",
      "Older yes",
    ]);
  });

  it("gives the three values: when, attending, and new in 24 hours", () => {
    expect(youthTemplateValues(yc, at)).toEqual(["21 Nov 2026, 4:00 pm", "2", "1 devotee"]);
  });

  it("is an .xlsx file", async () => {
    const bytes = await youthWorkbook(yc, at);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });

  it("uses its own numbers and time, or the registration report's when empty", () => {
    process.env.DAILY_REPORT_TO = "+919811111111";
    process.env.DAILY_REPORT_AT = "16:00";
    expect(youthReportConfig()).toEqual({ recipients: ["919811111111"], atMinutes: 960 });
    process.env.YC_REPORT_TO = "+919833333333";
    process.env.YC_REPORT_AT = "17:30";
    expect(youthReportConfig()).toEqual({ recipients: ["919833333333"], atMinutes: 1050 });
    delete process.env.YC_REPORT_TO;
    delete process.env.YC_REPORT_AT;
    delete process.env.DAILY_REPORT_TO;
    delete process.env.DAILY_REPORT_AT;
  });

  it("sends its own template and file, and counts only its own sends as done", async () => {
    process.env.DAILY_REPORT_TO = "+919811111111";
    db.registration.findMany.mockResolvedValue(yc);
    db.whatsAppMessage.findMany.mockResolvedValue([]);
    wa.uploadWhatsAppMedia.mockResolvedValue("media-yc");
    wa.sendWhatsAppTemplate.mockResolvedValue({ waMessageId: "wamid.yc" });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await sendReportIfDue(YOUTH_REPORT, new Date("2026-11-23T10:31:00Z"));

    expect(db.whatsAppMessage.findMany.mock.calls[0][0].where.purpose).toBe(YOUTH_REPORT_PURPOSE);
    expect(wa.sendWhatsAppTemplate.mock.calls[0][0]).toMatchObject({
      to: "919811111111",
      template: "daily_youth_convention_registrations_report",
      body: ["23 Nov 2026, 4:01 pm", "2", "0 devotees"],
      document: { id: "media-yc", filename: "youth-convention-report-2026-11-23.xlsx" },
      usage: { endpoint: YOUTH_REPORT_PURPOSE },
    });
    delete process.env.DAILY_REPORT_TO;
    vi.clearAllMocks();
  });
});
