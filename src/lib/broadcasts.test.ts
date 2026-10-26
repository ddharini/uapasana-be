/**
 * Send messages reaches many real phones at once and costs money per message,
 * so these pin what decides who gets what: which templates are offered, how
 * a typed text is cleaned for Meta, that dummy registrations and repeated
 * numbers are never messaged, and that the sender pauses instead of burning
 * through a list when every send is failing.
 */
import type { Registration } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  broadcasts: new Map<string, Record<string, unknown>>(),
  recipients: [] as Record<string, unknown>[],
}));

vi.mock("../utils/db", () => {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, want]) =>
      want && typeof want === "object" && "in" in (want as object)
        ? (want as { in: unknown[] }).in.includes(row[key])
        : row[key] === want
    );
  const apply = (row: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] =
        value && typeof value === "object" && "increment" in (value as object)
          ? (row[key] as number) + (value as { increment: number }).increment
          : value;
    }
  };
  return {
    prisma: {
      whatsAppBroadcast: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          db.broadcasts.get(where.id) ?? null,
        findMany: async () => [...db.broadcasts.values()].filter(b => b.status === "sending"),
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          apply(db.broadcasts.get(where.id)!, data),
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const rows = [...db.broadcasts.values()].filter(b => matches(b, where));
          rows.forEach(row => apply(row, data));
          return { count: rows.length };
        },
      },
      whatsAppBroadcastRecipient: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          db.recipients
            .filter(r => matches(r, where))
            .sort((a, b) => (a.order as number) - (b.order as number))[0] ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          apply(
            db.recipients.find(r => r.id === where.id)!,
            data
          ),
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const rows = db.recipients.filter(r => matches(r, where));
          rows.forEach(row => apply(row, data));
          return { count: rows.length };
        },
      },
    },
  };
});

vi.mock("./whatsapp", async importOriginal => {
  const real = await importOriginal<typeof import("./whatsapp")>();
  return { ...real, sendWhatsAppTemplate: vi.fn() };
});

import { WhatsAppSendError, sendWhatsAppTemplate, type MetaTemplate } from "./whatsapp";
import {
  chooseRecipients,
  cleanParam,
  renderBody,
  resumeBroadcasts,
  runBroadcast,
  sendableTemplates,
  valueFor,
  variableSpecSchema,
} from "./broadcasts";

const send = vi.mocked(sendWhatsAppTemplate);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  db.broadcasts.clear();
  db.recipients.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  send.mockReset();
});

const template = (overrides: Partial<MetaTemplate>): MetaTemplate => ({
  id: "1",
  name: "anoopam_update",
  status: "APPROVED",
  category: "UTILITY",
  language: "en",
  parameter_format: "POSITIONAL",
  components: [
    {
      type: "BODY",
      text: "Jay Shree Swaminarayan {{1}}, an update: {{2}} Reply here with questions.",
    },
  ],
  ...overrides,
});

describe("sendableTemplates", () => {
  it("offers approved Utility and Marketing templates, languages grouped, the announcement first", () => {
    const list = sendableTemplates([
      template({ name: "parking_info", language: "en" }),
      template({
        language: "gu",
        components: [
          { type: "BODY", text: "જય શ્રી સ્વામિનારાયણ {{1}}, {{2}} પ્રશ્નો હોય તો અહીં લખો." },
        ],
      }),
      template({ language: "en" }),
    ]);
    expect(list.map(t => t.name)).toEqual(["anoopam_update", "parking_info"]);
    expect(list[0].languages.map(l => [l.code, l.variables])).toEqual([
      ["gu", 2],
      ["en", 2],
    ]);
  });

  it("leaves out what it cannot fill or should not send from here", () => {
    const list = sendableTemplates([
      template({ name: "otp", category: "AUTHENTICATION" }),
      template({ name: "pending", status: "PENDING" }),
      template({ name: "named", parameter_format: "NAMED" }),
      template({
        name: "image",
        components: [
          { type: "HEADER", format: "IMAGE" },
          { type: "BODY", text: "Hi" },
        ],
      }),
      template({
        name: "header_blank",
        components: [
          { type: "HEADER", format: "TEXT", text: "For {{1}}" },
          { type: "BODY", text: "Hi" },
        ],
      }),
      template({
        name: "link_blank",
        components: [
          { type: "BODY", text: "Hi" },
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://x/{{1}}" }] },
        ],
      }),
      template({
        name: "ok_button",
        components: [
          { type: "BODY", text: "Hi" },
          {
            type: "BUTTONS",
            buttons: [{ type: "URL", text: "Map", url: "https://maps.app.goo.gl/x" }],
          },
        ],
      }),
    ]);
    expect(list.map(t => t.name)).toEqual(["ok_button"]);
    expect(list[0].languages[0]).toMatchObject({ variables: 0, buttons: ["Map"] });
  });
});

describe("cleanParam and the text blank", () => {
  it("turns line breaks and tabs into single spaces, as Meta requires", () => {
    expect(cleanParam("  Buses leave at 7.\n\nBring your\tpass.     Thanks  ")).toBe(
      "Buses leave at 7. Bring your pass. Thanks"
    );
  });

  it("refuses an empty or over-long text", () => {
    expect(variableSpecSchema.safeParse({ source: "text", text: " \n " }).success).toBe(false);
    expect(variableSpecSchema.safeParse({ source: "text", text: "x".repeat(701) }).success).toBe(
      false
    );
    expect(variableSpecSchema.parse({ source: "text", text: "Hello\nall" })).toEqual({
      source: "text",
      text: "Hello all",
    });
  });
});

const member = (id: string, extra: Partial<Registration["members"][number]> = {}) =>
  ({
    id,
    fullName: `Person ${id}`,
    firstName: `First${id}`,
    code: `DM-0${id}`,
    mobile: undefined,
    ...extra,
  }) as Registration["members"][number];

const registration = (
  id: string,
  members: Registration["members"],
  extra: Partial<Registration> = {}
) =>
  ({
    id,
    code: `DM-F-${id.slice(-2)}`,
    mandal: "Surat",
    isSample: false,
    members,
    ...extra,
  }) as Registration;

const R1 = "a".repeat(24);
const R2 = "b".repeat(24);
const R3 = "c".repeat(24);

describe("valueFor", () => {
  const r = registration(R1, [member("1")]);
  it("fills each kind of blank, never with an empty value", () => {
    const m = r.members[0];
    expect(valueFor({ source: "name" }, r, m)).toBe("Person 1");
    expect(valueFor({ source: "firstName" }, r, m)).toBe("First1");
    expect(valueFor({ source: "dmNumber" }, r, m)).toBe("DM-01");
    expect(valueFor({ source: "registrationNumber" }, r, m)).toBe("DM-F-aa");
    expect(valueFor({ source: "mandal" }, r, m)).toBe("Surat");
    expect(valueFor({ source: "dmNumber" }, r, member("2", { code: null }))).toBe("DM-F-aa");
  });
});

describe("chooseRecipients", () => {
  const specs = [{ source: "firstName" as const }, { source: "text" as const, text: "Buses at 7" }];
  const body = "Hi {{1}}: {{2}}";

  it("messages every person with a number once, in the order picked, never a dummy", () => {
    const family = registration(R1, [
      member("1", { mobile: "+919876543210" }),
      member("2", { mobile: "+919876543210" }), // the same number as the parent
      member("3"), // no number
      member("4", { mobile: "+91 99999 00000" }),
    ]);
    const dummy = registration(R2, [member("5", { mobile: "+919000000005" })], { isSample: true });
    const broken = registration(R3, [member("6", { mobile: "12" })]);
    const picks = [
      { registrationId: R1, memberId: "4" },
      { registrationId: R1, memberId: "1" },
      { registrationId: R1, memberId: "2" },
      { registrationId: R1, memberId: "3" },
      { registrationId: R2, memberId: "5" },
      { registrationId: R3, memberId: "6" },
      { registrationId: R1, memberId: "nobody" },
    ];
    const { recipients, skipped } = chooseRecipients([family, dummy, broken], picks, specs, body);
    expect(recipients.map(r => [r.order, r.to, r.name, r.values])).toEqual([
      [0, "919999900000", "Person 4", ["First4", "Buses at 7"]],
      [1, "919876543210", "Person 1", ["First1", "Buses at 7"]],
    ]);
    expect(skipped).toEqual({ duplicate: 1, noNumber: 1, notFound: 2, invalid: 1 });
  });

  it("says whose message would be over WhatsApp's 1024 characters", () => {
    const r = registration(R1, [member("1", { mobile: "+919876543210" })]);
    const long = [{ source: "text" as const, text: "x".repeat(700) }];
    expect(
      chooseRecipients(
        [r],
        [{ registrationId: R1, memberId: "1" }],
        long,
        "y".repeat(400) + "{{1}}"
      ).tooLong
    ).toBe("Person 1");
  });

  it("renders a body with its blanks filled", () => {
    expect(renderBody(body, ["Asha", "Buses at 7"])).toBe("Hi Asha: Buses at 7");
  });
});

describe("runBroadcast", () => {
  const seed = (count: number, status = "sending") => {
    db.broadcasts.set("b1", {
      id: "b1",
      status,
      template: "anoopam_update",
      language: "en",
      category: "UTILITY",
      createdById: "u1",
      accepted: 0,
      failed: 0,
    });
    for (let i = 0; i < count; i++) {
      db.recipients.push({
        id: `r${i}`,
        broadcastId: "b1",
        order: i,
        to: `9190000000${i}`,
        values: ["A"],
        status: "pending",
      });
    }
  };
  const run = async () => {
    const done = runBroadcast("b1");
    await vi.runAllTimersAsync();
    await done;
  };

  it("sends everyone in order, records each message id, and finishes", async () => {
    seed(3);
    send.mockImplementation(async ({ to }) => ({ waMessageId: `wamid.${to}` }));
    await run();
    expect(send.mock.calls.map(([o]) => o.to)).toEqual([
      "91900000000",
      "91900000001",
      "91900000002",
    ]);
    expect(send.mock.calls[0][0]).toMatchObject({
      languageCode: "en",
      category: "UTILITY",
      body: ["A"],
    });
    expect(db.recipients.map(r => [r.status, r.waMessageId])).toEqual([
      ["accepted", "wamid.91900000000"],
      ["accepted", "wamid.91900000001"],
      ["accepted", "wamid.91900000002"],
    ]);
    expect(db.broadcasts.get("b1")).toMatchObject({ status: "done", accepted: 3, failed: 0 });
  });

  it("pauses after 10 failures in a row and leaves the rest unsent", async () => {
    seed(15);
    send.mockRejectedValue(new WhatsAppSendError("Meta refused (131048): limit", 400, 131048));
    await run();
    expect(send).toHaveBeenCalledTimes(10);
    expect(db.broadcasts.get("b1")).toMatchObject({ status: "paused", failed: 10 });
    expect(db.broadcasts.get("b1")?.pauseReason).toMatch(/10 messages in a row failed.*131048/);
    expect(db.recipients.filter(r => r.status === "pending")).toHaveLength(5);
  });

  it("pauses at once when the token stops working", async () => {
    seed(5);
    send.mockRejectedValue(
      new WhatsAppSendError("WA_ACCESS_TOKEN is expired or invalid", 401, 190)
    );
    await run();
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.broadcasts.get("b1")).toMatchObject({ status: "paused" });
  });

  it("does nothing for a stopped send, and never resends one caught mid-send", async () => {
    seed(2, "cancelled");
    await run();
    expect(send).not.toHaveBeenCalled();

    db.broadcasts.get("b1")!.status = "sending";
    db.recipients[0].status = "sending"; // the server stopped while this one was going out
    send.mockResolvedValue({ waMessageId: "wamid.x" });
    await resumeBroadcasts();
    await vi.runAllTimersAsync();
    expect(db.recipients[0]).toMatchObject({ status: "failed" });
    expect(send.mock.calls.map(([o]) => o.to)).toEqual(["91900000001"]);
  });
});
