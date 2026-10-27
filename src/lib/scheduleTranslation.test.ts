import { beforeEach, describe, expect, it, vi } from "vitest";

// A hand-rolled fake rather than vi.fn: vitest reports a vi.fn's rejected
// promise as a test failure even when the code under test catches it.
let reply: (opts: { user: string }) => Promise<unknown>;
const calls: { user: string }[] = [];
vi.mock("./ai/claude", async importOriginal => ({
  ...(await importOriginal<typeof import("./ai/claude")>()),
  completeJson: (opts: { user: string }) => {
    calls.push(opts);
    return reply(opts);
  },
  isAiConfigured: () => true,
}));

import { snapshotOf } from "./schedule";
import { textsOf, translateSchedule, translationsOf, untranslated } from "./scheduleTranslation";

const session = (title: string, extra: object = {}) => ({
  id: title,
  start: "09:30",
  end: "12:30",
  title,
  kind: "sabha",
  place: "Sabha Hall",
  mapUrl: null,
  note: null,
  ...extra,
});

const days = snapshotOf([
  {
    date: "2027-01-31",
    theme: "Hirak Mahotsav",
    sessions: [
      session("Afternoon session", { note: "Tentative – timing to be confirmed" }),
      session("Maanbhatt Prastuti", { kind: "Yoga Shibir" }),
    ],
  },
]);

beforeEach(() => {
  calls.length = 0;
  reply = async () => ({ gu: [] });
});

describe("schedule translation", () => {
  it("collects each theme, title, place and note once, and not custom types", () => {
    expect(textsOf(days)).toEqual([
      "Hirak Mahotsav",
      "Afternoon session",
      "Sabha Hall",
      "Tentative – timing to be confirmed",
      "Maanbhatt Prastuti",
    ]);
  });

  it("asks only for what the last publication did not translate", async () => {
    reply = async () => ({ gu: ["બપોરની સભા", "માનભટ્ટ પ્રસ્તુતિ"] });
    const previous = {
      "Hirak Mahotsav": "હીરક મહોત્સવ",
      "Sabha Hall": "સભા હૉલ",
      "Tentative – timing to be confirmed": "સમય હજી નક્કી નથી",
      "Removed session": "કાઢી નાખેલી સભા",
    };
    const gu = await translateSchedule(days, previous);
    expect(JSON.parse(calls[0].user)).toEqual(["Afternoon session", "Maanbhatt Prastuti"]);
    expect(gu["Afternoon session"]).toBe("બપોરની સભા");
    expect(gu["Sabha Hall"]).toBe("સભા હૉલ");
    // Text no longer in the programme is not carried forward.
    expect(gu).not.toHaveProperty("Removed session");
    expect(untranslated(days, gu)).toEqual([]);
  });

  it("makes no call when everything is already translated", async () => {
    const all = Object.fromEntries(textsOf(days).map(t => [t, `gu:${t}`]));
    expect(await translateSchedule(days, all)).toEqual(all);
    expect(calls).toEqual([]);
  });

  it("publishes in English rather than fail, when the reply is unusable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reply = async () => ({ gu: ["only one"] });
    const gu = await translateSchedule(days, { "Sabha Hall": "સભા હૉલ" });
    expect(gu).toEqual({ "Sabha Hall": "સભા હૉલ" });

    reply = async () => {
      throw new Error("529 overloaded");
    };
    expect(await translateSchedule(days, {})).toEqual({});
  });

  it("reads a missing or malformed stored map as empty", () => {
    expect(translationsOf(null)).toEqual({});
    expect(translationsOf({ gu: null })).toEqual({});
    expect(translationsOf({ gu: ["x"] })).toEqual({});
    expect(translationsOf({ gu: { a: "અ", b: 3 } })).toEqual({ a: "અ" });
  });
});
