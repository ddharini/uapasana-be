/**
 * This helper exists because of one bug that cost a whole debugging session, and
 * these tests exist so it cannot come back quietly.
 *
 * Prisma does not write optional fields that were never given a value, so a new
 * row has no key for the lock at all. `findUnique` still reports `null`, so
 * every read path believes the row is unlocked — but `where: { lockedAt: null }`
 * does not match a document with no such key, and neither does
 * `NOT: { lockedAt: { gte: stale } }`. Both were measured against a real
 * MongoDB collection and both matched zero rows. The claim then fails forever
 * and every caller is told somebody holds a lock that does not exist.
 *
 * `isSet: false` is the only clause that matches an absent key. Asserting its
 * presence is the whole point: a future tidy-up that "simplifies" the OR back
 * to a null check would reintroduce an endless retry loop, and nothing else
 * here would fail.
 */
import { describe, expect, it, vi } from "vitest";

import { claimable } from "./locks";

const TTL = 60_000;

describe("claimable", () => {
  it("matches a row whose lock key was never written — the case a null check misses", () => {
    const clauses = claimable("lockedAt", TTL).OR;
    expect(clauses).toContainEqual({ lockedAt: { isSet: false } });
  });

  it("matches a row whose lock was explicitly cleared", () => {
    expect(claimable("lockedAt", TTL).OR).toContainEqual({ lockedAt: null });
  });

  it("matches a row whose lock has expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));

    const clauses = claimable("lockedAt", TTL).OR;
    expect(clauses).toContainEqual({
      lockedAt: { lt: new Date("2026-09-08T11:59:00.000Z") },
    });

    vi.useRealTimers();
  });

  it("offers exactly the three ways a lock can be free, and no more", () => {
    // A fourth clause would most likely be one that also matches a lock somebody
    // currently holds, which is the failure this guards against from the other
    // direction: a claim that always succeeds is not a lock at all.
    expect(claimable("lockedAt", TTL).OR).toHaveLength(3);
  });

  it("names whichever field it is given", () => {
    const clauses = claimable("bioGeneratingAt", TTL).OR;
    for (const clause of clauses) {
      expect(Object.keys(clause)).toEqual(["bioGeneratingAt"]);
    }
  });

  it("computes the staleness cutoff from the TTL it is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));

    const short = claimable("lockedAt", 1_000).OR.at(-1) as { lockedAt: { lt: Date } };
    const long = claimable("lockedAt", 3_600_000).OR.at(-1) as { lockedAt: { lt: Date } };

    expect(short.lockedAt.lt).toEqual(new Date("2026-09-08T11:59:59.000Z"));
    expect(long.lockedAt.lt).toEqual(new Date("2026-09-08T11:00:00.000Z"));

    vi.useRealTimers();
  });
});
