import { describe, expect, it, vi } from "vitest";

// The generator module imports the Prisma client for its insert/remove
// helpers; building the samples never touches it.
vi.mock("../utils/db", () => ({ prisma: {} }));

import { EVENT_DAYS, YOUTH_MAX_AGE, isLocalMandal } from "./event";
import { newRegistrationSchema, toCreateData } from "./registrations";
import { SAMPLE_COUNT, buildSampleRegistrations } from "./sample-registrations";

/**
 * The dummy registrations go through the same check as a real one when they
 * are added. These tests make a rule the samples break fail here, rather than
 * as an error on the admin's "Show dummy data" button.
 */

const samples = buildSampleRegistrations();
const inputOf = ({
  sequence: _sequence,
  code: _code,
  memberCodes: _memberCodes,
  status: _status,
  source: _source,
  createdAt: _createdAt,
  mobileVerification: _mobileVerification,
  verifiedByName: _verifiedByName,
  ...input
}: (typeof samples)[number]) => input;

const slotOf = (time: string) => {
  const hour = Number(time.slice(0, 2));
  return hour < 12 ? "morning" : hour < 16 ? "afternoon" : "evening";
};

describe("sample registrations", () => {
  it("are the advertised number, with unique codes and contact numbers", () => {
    expect(samples).toHaveLength(SAMPLE_COUNT);
    expect(new Set(samples.map(s => s.code)).size).toBe(SAMPLE_COUNT);
    const people = samples.flatMap(s => s.memberCodes);
    expect(new Set(people).size).toBe(people.length);
    expect(samples.flatMap(s => s.members)).toHaveLength(people.length);
    for (const s of samples)
      expect(s.code).toEqual(s.type === "family" ? expect.stringMatching(/^DMS-F-\d{4}$/) : s.memberCodes[0]);
    expect(new Set(samples.map(s => s.members[0].mobile)).size).toBe(SAMPLE_COUNT);
  });

  it.each(samples.map(s => [s.code, s] as const))(
    "%s passes the registration form's rules",
    (_code, sample) => {
      const parsed = newRegistrationSchema.safeParse(inputOf(sample));
      expect(
        parsed.success ? [] : parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`)
      ).toEqual([]);
    }
  );

  it("only use event days", () => {
    const days: readonly string[] = EVENT_DAYS;
    for (const s of samples)
      for (const m of s.members) {
        expect(days).toContain(m.arrival.date);
        expect(days).toContain(m.departure.date);
      }
  });

  it("time trains, buses and flights to the arrival and departure slots", () => {
    for (const s of samples) {
      if (s.travel.arrivalTime) expect(slotOf(s.travel.arrivalTime)).toBe(s.arrival.slot);
      if (s.travel.departureTime) expect(slotOf(s.travel.departureTime)).toBe(s.departure.slot);
    }
  });

  it("cover the newer parts of the form", () => {
    const saved = samples.map(s => toCreateData(newRegistrationSchema.parse(inputOf(s))));
    const people = saved.flatMap(r => r.members);

    // A family with someone not needing a bed.
    expect(
      saved.some(r => r.accommodationRequired && r.members.some(m => !m.needsAccommodation))
    ).toBe(true);
    // Youth Convention answers, both ways, only for 40 and under.
    expect(people.some(m => m.attendsYouthConvention === true)).toBe(true);
    expect(people.some(m => m.attendsYouthConvention === false)).toBe(true);
    expect(people.every(m => m.age <= YOUTH_MAX_AGE || m.attendsYouthConvention == null)).toBe(
      true
    );
    // Both ways of verifying the contact's mobile.
    expect(new Set(samples.map(s => s.mobileVerification))).toEqual(new Set(["otp", "in_person"]));
    expect(
      samples.every(s => (s.mobileVerification === "in_person") === Boolean(s.verifiedByName))
    ).toBe(true);
    // Pickups and drops, and nearby mandals with neither travel nor beds.
    expect(saved.some(r => r.travel.needsPickup && r.travel.needsDrop)).toBe(true);
    expect(
      saved
        .filter(r => isLocalMandal(r.mandal))
        .every(r => r.travel.mode === "local" && !r.accommodationRequired)
    ).toBe(true);
  });
});
