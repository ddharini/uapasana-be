/**
 * One mobile number, one registration. The cases are the owner's four from
 * 2026-11-19: a family sharing a number among its own people (allowed), the
 * same person on a second registration, a family's contact number reused
 * (that one is `contactTaken`'s), and a number typed against a mother in one
 * family reused by her daughter registering alone — refused too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("../utils/db", () => ({ prisma: { registration: { findMany: (...args: unknown[]) => findMany(...args) } } }));

import { numbersInUse, toNumberUseSummary } from "./number-in-use";

const person = (fullName: string, mobile: string | null) => ({
  id: `m-${fullName}`,
  code: `DM-${fullName.length}`,
  fullName,
  mobile,
  arrival: { date: "2027-01-29", slot: "morning", meal: true },
  departure: { date: "2027-02-01", slot: "evening", meal: true },
});

const patel = {
  id: "f1",
  code: "DM-F-0194",
  members: [person("Darsh Patel", "+919800011111"), person("Shrut Gaurang Patel", "+918100022222")],
};

describe("numbersInUse", () => {
  beforeEach(() => findMany.mockReset());

  it("refuses the same person registering alone (Shrut)", async () => {
    findMany.mockResolvedValue([patel]);
    const found = await numbersInUse([{ mobile: "+918100022222" }]);
    expect(found).toHaveLength(1);
    expect(found[0].index).toBe(0);
    expect(found[0].registration.code).toBe("DM-F-0194");
    expect(found[0].member.fullName).toBe("Shrut Gaurang Patel");
  });

  it("refuses a different person on a number another registration uses (Aastha on her mother's entry)", async () => {
    const soni = { id: "f2", code: "DM-F-0235", members: [person("Brijesh Soni", "+919900033333"), person("Pinal Ben Soni", "+919300044444")] };
    findMany.mockResolvedValue([soni]);
    const found = await numbersInUse([{ mobile: "+919300044444" }]);
    expect(found.map((f) => f.member.fullName)).toEqual(["Pinal Ben Soni"]);
  });

  it("marks a family member whose number is on another registration", async () => {
    findMany.mockResolvedValue([{ id: "i1", code: "DM-0276", members: [person("SHRUT GAURANG RUDANI", "+918100022222")] }]);
    const found = await numbersInUse([{ mobile: "+919800011111" }, { mobile: "+918100022222" }]);
    expect(found.map((f) => f.index)).toEqual([1]);
  });

  it("lets a family give one number to several of its own people", async () => {
    findMany.mockResolvedValue([]);
    const found = await numbersInUse([{ mobile: "+919800011111" }, { mobile: "+919800011111" }]);
    expect(found).toEqual([]);
    expect(findMany.mock.calls[0][0].where.members.some.mobile.in).toEqual(["+919800011111"]);
  });

  it("does not ask the database when nobody has a number", async () => {
    expect(await numbersInUse([{ mobile: null }, {}])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("on an edit, leaves alone numbers the registration already had", async () => {
    findMany.mockResolvedValue([patel]);
    const kept = { id: "i1", members: [person("SHRUT GAURANG RUDANI", "+918100022222")] } as never;
    expect(await numbersInUse([{ mobile: "+918100022222" }], kept)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("looks only at active, real registrations other than the one being edited", async () => {
    findMany.mockResolvedValue([]);
    await numbersInUse([{ mobile: "+918100022222" }], { id: "x1", members: [] } as never);
    const where = findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: "cancelled" });
    expect(where.isSample).toEqual({ not: true });
    expect(where.id).toEqual({ not: "x1" });
  });
});

describe("toNumberUseSummary", () => {
  const registration = { ...patel, type: "family", groupName: "Patel Family", mandal: "Ahmedabad", status: "pending" } as never;

  it("gives a refused submit only enough to recognise the registration", () => {
    const summary = toNumberUseSummary(registration, patel.members[1] as never, false);
    expect(summary).toMatchObject({ code: "DM-F-0194", name: "Patel Family", contactName: "Darsh Patel", personName: "Shrut Gaurang Patel" });
    expect(summary).not.toHaveProperty("arrival");
    expect(summary).not.toHaveProperty("id");
  });

  it("adds dates, without meals, for someone who proved the number", () => {
    const summary = toNumberUseSummary(registration, patel.members[1] as never, true);
    expect(summary).toMatchObject({ id: "f1", status: "confirmed", arrival: { date: "2027-01-29", slot: "morning" } });
    expect(summary.arrival).not.toHaveProperty("meal");
  });
});
