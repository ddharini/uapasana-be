/**
 * The queue's one hard requirement: two workers must never run the same job.
 *
 * Everything else here is failure handling, which matters for a different
 * reason — a job that dies silently takes a user's scheduled post with it, and
 * nobody finds out until the post does not appear.
 *
 * Prisma is faked in memory rather than mocked call-by-call, because the thing
 * under test IS the concurrency: a `vi.fn()` returning a fixed row cannot
 * express "the second writer loses".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";

interface Row {
  [key: string]: unknown;
}

let jobs: Row[] = [];

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    if (cond !== null && typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      if ("lt" in c) return row[key] != null && (row[key] as Date) < (c.lt as Date);
      if ("lte" in c) return row[key] != null && (row[key] as Date) <= (c.lte as Date);
      if ("in" in c) return (c.in as unknown[]).includes(row[key]);
      if ("notIn" in c) return !(c.notIn as unknown[]).includes(row[key]);
      return false;
    }
    return row[key] === cond;
  });

/** `{ increment: n }` is the one Prisma write operator this module uses. */
const applyData = (row: Row, data: Row) => {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in (value as Row)) {
      row[key] = ((row[key] as number) ?? 0) + ((value as { increment: number }).increment);
    } else {
      row[key] = value;
    }
  }
};

const job = {
  create: async ({ data, select }: { data: Row; select?: Row }) => {
    const row: Row = {
      id: randomBytes(12).toString("hex"),
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
      runAfter: new Date(),
      lockedAt: null,
      lastError: null,
      createdAt: new Date(),
      ...data,
    };
    jobs.push(row);
    return select ? { id: row.id } : row;
  },
  // Copies, not the live rows. Prisma returns detached objects, and aliasing
  // them here would hide a real class of bug: code that reads a field after a
  // concurrent write would see the new value in the fake and the old one in
  // production.
  findFirst: async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
    const found = jobs.filter((r) => matches(r, where));
    if (orderBy && "runAfter" in orderBy) {
      found.sort((a, b) => (a.runAfter as Date).getTime() - (b.runAfter as Date).getTime());
    }
    return found[0] ? { ...found[0] } : null;
  },
  findMany: async ({ where }: { where?: Row } = {}) =>
    (where ? jobs.filter((r) => matches(r, where)) : jobs).map((r) => ({ ...r })),
  // Atomic: writes land synchronously before any await yields, which is the
  // single-document serialisation MongoDB guarantees.
  updateMany: async ({ where, data }: { where: Row; data: Row }) => {
    const found = jobs.filter((r) => matches(r, where));
    found.forEach((r) => applyData(r, data));
    return { count: found.length };
  },
  update: async ({ where, data }: { where: Row; data: Row }) => {
    const row = jobs.find((r) => matches(r, where));
    if (!row) throw new Error("not found");
    applyData(row, data);
    return row;
  },
};

vi.mock("../../utils/db", () => ({
  prisma: {
    get job() {
      return job;
    },
  },
}));

import { claimJob, completeJob, enqueue, failJob, isQueued, reapStuckJobs } from "./claim";
import type { JobKind } from "./claim";

/**
 * These tests exercise the queue's mechanics — claiming, backoff, reaping —
 * which are the same whatever kinds a product happens to register. `JobKind` is
 * deliberately narrow (see claim.ts), so rather than widening it for the tests'
 * benefit, or rewriting every case each time the union changes, they name their
 * own kinds through this cast.
 */
const k = (name: string) => name as JobKind;

beforeEach(() => {
  jobs = [];
});

describe("enqueue", () => {
  it("queues a runnable job", async () => {
    const id = await enqueue(k("import_posts"), { userId: "u1" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id, kind: k("import_posts"), status: "pending", attempts: 0 });
  });

  it("schedules for later when given runAfter", async () => {
    const when = new Date(Date.now() + 3600_000);
    await enqueue(k("publish"), { itemId: "c1" }, { runAfter: when });
    expect(jobs[0].runAfter).toBe(when);
  });
});

describe("claimJob", () => {
  it("returns null when the queue is empty", async () => {
    expect(await claimJob()).toBeNull();
  });

  it("does not claim a job scheduled for the future", async () => {
    await enqueue(k("publish"), {}, { runAfter: new Date(Date.now() + 60_000) });
    expect(await claimJob()).toBeNull();
  });

  it("marks the job running and increments attempts", async () => {
    await enqueue(k("import_posts"), { userId: "u1" });
    const claimed = await claimJob();

    expect(claimed).toMatchObject({ kind: k("import_posts"), attempts: 1 });
    expect(jobs[0].status).toBe("running");
    expect(jobs[0].lockedAt).toBeInstanceOf(Date);
  });

  it("gives one job to exactly ONE of several concurrent workers", async () => {
    await enqueue(k("publish"), { itemId: "c1" });

    const results = await Promise.all([claimJob(), claimJob(), claimJob(), claimJob()]);
    const winners = results.filter(Boolean);

    // The whole reason this file exists. Two workers publishing the same thread
    // is a double post, and X will not take it back.
    expect(winners).toHaveLength(1);
    expect(jobs[0].attempts).toBe(1);
  });

  it("hands different jobs to concurrent workers rather than starving them", async () => {
    await enqueue(k("publish"), { itemId: "c1" });
    await enqueue(k("publish"), { itemId: "c2" });
    await enqueue(k("publish"), { itemId: "c3" });

    const results = await Promise.all([claimJob(), claimJob(), claimJob()]);
    const ids = results.filter(Boolean).map((j) => j!.id);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("takes the oldest runnable job first, so nothing starves", async () => {
    await enqueue(k("publish"), { n: 2 }, { runAfter: new Date(Date.now() - 1000) });
    await enqueue(k("publish"), { n: 1 }, { runAfter: new Date(Date.now() - 60_000) });

    expect((await claimJob())!.payload).toEqual({ n: 1 });
  });

  it("filters by kind when asked", async () => {
    await enqueue(k("import_posts"), { userId: "u1" });
    await enqueue(k("publish"), { itemId: "c1" });

    expect((await claimJob([k("publish")]))!.kind).toBe(k("publish"));
  });
});

describe("failJob", () => {
  it("backs off exponentially and stays pending", async () => {
    await enqueue(k("publish"), {});
    const claimed = (await claimJob())!;

    const { willRetry, nextRunAt } = await failJob(claimed, new Error("network blip"));

    expect(willRetry).toBe(true);
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].lockedAt).toBeNull();
    // 2^1 minutes for the first attempt.
    const delayMinutes = (nextRunAt!.getTime() - Date.now()) / 60_000;
    expect(delayMinutes).toBeGreaterThan(1.5);
    expect(delayMinutes).toBeLessThan(2.5);
  });

  it("gives up immediately on a permanent failure, without burning retries", async () => {
    await enqueue(k("publish"), {});
    const claimed = (await claimJob())!;

    const { willRetry } = await failJob(claimed, new Error("no such account"), { permanent: true });

    expect(willRetry).toBe(false);
    expect(jobs[0].status).toBe("failed");
  });

  it("honours an explicit retryAt over the backoff — X names its own reset time", async () => {
    await enqueue(k("publish"), {});
    const claimed = (await claimJob())!;
    const reset = new Date(Date.now() + 12_000);

    const { nextRunAt } = await failJob(claimed, new Error("429"), { retryAt: reset });

    expect(nextRunAt).toBe(reset);
    expect(jobs[0].runAfter).toBe(reset);
  });

  it("stops for good once attempts are exhausted, keeping the last error", async () => {
    await enqueue(k("publish"), {}, { maxAttempts: 2 });

    await failJob((await claimJob())!, new Error("first"));
    jobs[0].runAfter = new Date(Date.now() - 1000); // pretend the backoff elapsed
    const { willRetry } = await failJob((await claimJob())!, new Error("second"));

    expect(willRetry).toBe(false);
    expect(jobs[0].status).toBe("failed");
    // A job that fails and then erases why is worse than one that never ran.
    expect(jobs[0].lastError).toBe("second");
  });

  it("truncates a huge error rather than storing a stack trace forever", async () => {
    await enqueue(k("publish"), {});
    await failJob((await claimJob())!, new Error("x".repeat(5000)), { permanent: true });
    expect((jobs[0].lastError as string).length).toBe(1000);
  });
});

describe("completeJob", () => {
  it("clears the lock and the previous error", async () => {
    await enqueue(k("publish"), {});
    const claimed = (await claimJob())!;
    await failJob(claimed, new Error("transient"));
    jobs[0].runAfter = new Date(Date.now() - 1000);

    await completeJob((await claimJob())!.id);

    expect(jobs[0]).toMatchObject({ status: "completed", lockedAt: null, lastError: null });
  });
});

describe("reapStuckJobs", () => {
  it("returns a job abandoned by a dead worker", async () => {
    await enqueue(k("publish"), {});
    await claimJob();
    jobs[0].lockedAt = new Date(Date.now() - 30 * 60_000);

    expect(await reapStuckJobs()).toBe(1);
    expect(jobs[0].status).toBe("pending");
  });

  it("leaves a job that is merely slow alone", async () => {
    await enqueue(k("publish"), {});
    await claimJob();

    expect(await reapStuckJobs()).toBe(0);
    expect(jobs[0].status).toBe("running");
  });

  it("does not reset attempts — a job that kills workers must still exhaust", async () => {
    await enqueue(k("publish"), {});
    await claimJob();
    jobs[0].lockedAt = new Date(Date.now() - 30 * 60_000);

    await reapStuckJobs();
    expect(jobs[0].attempts).toBe(1);
  });
});

describe("isQueued", () => {
  it("sees pending and running work for that user", async () => {
    await enqueue(k("import_posts"), { userId: "u1" });
    expect(await isQueued(k("import_posts"), "u1")).toBe(true);

    await claimJob();
    expect(await isQueued(k("import_posts"), "u1")).toBe(true);
  });

  it("ignores another user's work", async () => {
    await enqueue(k("import_posts"), { userId: "u1" });
    expect(await isQueued(k("import_posts"), "u2")).toBe(false);
  });

  it("ignores finished work, so a rebuild is possible", async () => {
    await enqueue(k("import_posts"), { userId: "u1" });
    await completeJob((await claimJob())!.id);
    expect(await isQueued(k("import_posts"), "u1")).toBe(false);
  });
});
