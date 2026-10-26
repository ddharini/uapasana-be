import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/db", () => ({ prisma: {} }));

import { type Counter, withCodes } from "./registration-codes";

/** A counter per kind, starting from 0 like a fresh database. */
function counters() {
  const values: Record<Counter, number> = { registration: 0, person: 0, family: 0 };
  return async (counter: Counter, count: number) =>
    Array.from({ length: count }, () => ++values[counter]);
}

const people = (...ids: string[]) => ids.map(id => ({ id }));

describe("registration numbers", () => {
  it("an individual goes by their own number", async () => {
    const saved = await withCodes({ type: "individual", members: people("a") }, undefined, counters());
    expect(saved.members.map(m => m.code)).toEqual(["DM-0101"]);
    expect(saved.code).toBe("DM-0101");
  });

  it("a family gets a family number and one per person", async () => {
    const take = counters();
    await withCodes({ type: "individual", members: people("x") }, undefined, take);
    const saved = await withCodes({ type: "family", members: people("a", "b", "c") }, undefined, take);
    expect(saved.members.map(m => m.code)).toEqual(["DM-0102", "DM-0103", "DM-0104"]);
    expect(saved.code).toBe("DM-F-0101");
  });

  it("an edit keeps everyone's number and numbers only the new people", async () => {
    const take = counters();
    const first = await withCodes({ type: "family", members: people("a", "b", "c") }, undefined, take);
    // b leaves, d joins.
    const edited = await withCodes({ type: "family", members: people("a", "c", "d") }, first, take);
    expect(edited.members.map(m => m.code)).toEqual(["DM-0101", "DM-0103", "DM-0104"]);
    expect(edited.code).toBe("DM-F-0101");
  });

  it("follows a change between individual and family", async () => {
    const take = counters();
    const alone = await withCodes({ type: "individual", members: people("a") }, undefined, take);
    const family = await withCodes({ type: "family", members: people("a", "b") }, alone, take);
    expect(family.code).toBe("DM-F-0101");
    expect(family.members.map(m => m.code)).toEqual(["DM-0101", "DM-0102"]);
    const back = await withCodes({ type: "individual", members: people("a") }, family, take);
    expect(back.code).toBe("DM-0101");
  });

  it("ignores a number the client sent", async () => {
    const saved = await withCodes(
      { type: "individual", members: [{ id: "a", code: "DM-9999" }] },
      undefined,
      counters()
    );
    expect(saved.code).toBe("DM-0101");
  });
});
