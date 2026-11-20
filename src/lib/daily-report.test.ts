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
  it("leaves cancelled out of every count and the list, and counts it on its own", () => {
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
    expect(report).toMatchObject({
      registrations: 2,
      people: 3,
      families: 1,
      individuals: 1,
      checkedIn: 1,
      cancelled: 1,
    });
    expect(report.devotees).toHaveLength(3);
    expect(report.mandals.map(line => [line.mandal, line.people, line.male, line.female])).toEqual([
      ["Surat", 2, 1, 1],
      ["Vadodara", 1, 1, 0],
    ]);
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
    expect(report.mandals[0].newPeople).toBe(2);
  });

  it("reads a separately travelling person's own mode, and a bed only when asked for", () => {
    const report = summarise(
      [
        registration({
          travel: { mode: "separate" },
          members: [person({ travel: { mode: "flight" }, needsAccommodation: false })],
        }),
      ],
      at
    );
    const row = report.devotees[0];
    expect(row[10]).toBe("Flight");
    expect(row[11]).toBe("No");
    expect(row[7]).toBe("+919876543210"); // the contact's number, from the registration
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
    const bytes = await reportWorkbook(summarise([registration()], at));
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
