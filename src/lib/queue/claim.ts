import { prisma } from "../../utils/db";

/**
 * The job queue: enqueue, claim, complete, fail.
 *
 * A MongoDB collection rather than Redis/BullMQ, deliberately. At the volume a
 * new product runs at, queue depth is trivial, and a queue you can inspect with
 * the same client as the rest of your data — and back up with the same snapshot
 * — is worth more than one that is faster. Swap it out when the numbers say to,
 * not before.
 *
 * ## How the claim is made atomic
 *
 * Postgres would use `SELECT ... FOR UPDATE SKIP LOCKED`. MongoDB has no
 * equivalent, so this uses a guarded `updateMany`, for three reasons:
 *
 *  1. It is genuinely atomic. MongoDB serialises writes to a single document, so
 *     of two workers issuing `updateMany({ id, status: 'pending' } → running)`
 *     exactly one sees `count === 1`. The loser reads 0 and moves on.
 *  2. It stays inside Prisma's typed client. `$runCommandRaw` returns MongoDB
 *     extended JSON, so every date and ObjectId would need hand-decoding at the
 *     one place in the system where a subtle deserialisation bug is hardest to
 *     notice.
 *  3. It is the same compare-and-set idiom as `src/utils/locks.ts`, so there is
 *     one concurrency pattern in this codebase rather than two.
 *
 * The cost is an extra round trip per candidate: a read to find one, a write to
 * take it. That is the right trade at this volume and would be the wrong one at
 * a hundred times it — at which point `findAndModify` is the upgrade, not Redis.
 */

/**
 * Every kind of work the worker knows how to do.
 *
 * Add yours here, then route it in `dispatch` in src/worker/index.ts. Keeping
 * the union here rather than accepting any string is what makes a typo in an
 * `enqueue` call a compile error instead of a job that sits pending forever.
 *
 * `never` until the first kind is registered: nothing can be enqueued yet, and
 * replacing it with a string-literal union is all it takes to start.
 */
export type JobKind = never;

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * A job still marked `running` after this long belonged to a worker that died
 * holding it. Generous, because the alternative failure — reclaiming a job that
 * is merely slow, and running it twice — is the worse one. Handlers are expected
 * to be idempotent anyway, but "expected to be" is not a reason to arrange it.
 */
const STUCK_AFTER_MS = 15 * 60 * 1000;

/** How many candidates to look at before giving up on a tick. */
const CLAIM_ATTEMPTS_PER_JOB = 5;

export interface EnqueueOptions {
  /** Don't run before this instant. How scheduling is expressed. */
  runAfter?: Date;
  maxAttempts?: number;
}

/** Adds one job. */
export const enqueue = async (
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {}
): Promise<string> => {
  const job = await prisma.job.create({
    data: {
      kind,
      payload: payload as never,
      runAfter: opts.runAfter ?? new Date(),
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    },
    select: { id: true },
  });
  return job.id;
};

/**
 * Whether a job of this kind is already queued for this user.
 *
 * Used to keep someone hammering a button from queueing five identical jobs.
 * Not a lock — two callers racing this check can both enqueue — but handlers
 * should be idempotent anyway, and a rare duplicate costs one wasted call
 * against a guard that would otherwise need a second collection to hold it.
 *
 * Matches on `payload.userId`, so it only works for jobs that carry one.
 */
export const isQueued = async (kind: JobKind, userId: string): Promise<boolean> => {
  const open = await prisma.job.findMany({
    where: { kind, status: { in: ["pending", "running"] } },
    select: { payload: true },
  });
  return open.some(job => (job.payload as { userId?: string } | null)?.userId === userId);
};

/**
 * Takes one job, or returns null if there is nothing to do.
 *
 * Reads a candidate, then tries to take it with a write guarded on the state it
 * was read in. Losing that race is normal, not an error — another worker got
 * there first, so try the next candidate.
 */
export const claimJob = async (kinds?: JobKind[]): Promise<ClaimedJob | null> => {
  const seen = new Set<string>();

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS_PER_JOB; attempt++) {
    const candidate = await prisma.job.findFirst({
      where: {
        status: "pending",
        runAfter: { lte: new Date() },
        ...(kinds ? { kind: { in: kinds } } : {}),
        ...(seen.size ? { id: { notIn: [...seen] } } : {}),
      },
      // Oldest first, so a job never starves behind newer work.
      orderBy: { runAfter: "asc" },
      select: { id: true, kind: true, payload: true, attempts: true, maxAttempts: true },
    });

    if (!candidate) return null;
    seen.add(candidate.id);

    // The atomic bit. `status: "pending"` in the filter is the compare half of
    // the compare-and-set — without it two workers both "claim" the same row.
    const { count } = await prisma.job.updateMany({
      where: { id: candidate.id, status: "pending" },
      data: {
        status: "running",
        lockedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    if (count === 1) {
      return {
        id: candidate.id,
        kind: candidate.kind,
        payload: (candidate.payload ?? {}) as Record<string, unknown>,
        // The row now holds attempts + 1; report what this run actually is.
        attempts: candidate.attempts + 1,
        maxAttempts: candidate.maxAttempts,
      };
    }
  }

  return null;
};

/** Marks a job done. */
export const completeJob = async (id: string): Promise<void> => {
  await prisma.job.update({
    where: { id },
    data: { status: "completed", lockedAt: null, lastError: null },
  });
};

/**
 * Records a failure and decides whether to try again.
 *
 * Exponential backoff at `2^attempts` minutes — 2, 4, 8, 16, 32 — until
 * `maxAttempts`, then the job stops for good with its last error preserved.
 * Keeping the error is the point: a job that fails five times and then erases
 * why is worse than one that never ran.
 *
 * `retryAt` overrides the backoff entirely. An upstream 429 that names the exact
 * second its window reopens beats any exponential guess — guessing shorter means
 * burning attempts on calls that cannot possibly succeed yet.
 */
export const failJob = async (
  job: ClaimedJob,
  error: unknown,
  opts: { permanent?: boolean; retryAt?: Date } = {}
): Promise<{ willRetry: boolean; nextRunAt: Date | null }> => {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const willRetry = !opts.permanent && !exhausted;

  if (!willRetry) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        lockedAt: null,
        lastError: message.slice(0, 1000),
      },
    });
    return { willRetry: false, nextRunAt: null };
  }

  const nextRunAt = opts.retryAt ?? new Date(Date.now() + Math.pow(2, job.attempts) * 60 * 1000);

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: "pending",
      lockedAt: null,
      runAfter: nextRunAt,
      lastError: message.slice(0, 1000),
    },
  });

  return { willRetry: true, nextRunAt };
};

/**
 * Why the most recent attempt for this user failed, if it did.
 *
 * Exists because a background job that fails silently is indistinguishable, from
 * the browser, from one that never ran: the UI polls, sees the work is no longer
 * queued, and quietly reverts to its empty state. The user is left watching a
 * spinner disappear with nothing to act on — while the server holds a perfectly
 * clear explanation nobody showed them. Surface this on whatever screen was
 * waiting.
 */
export const lastFailure = async (
  kinds: JobKind[],
  userId: string
): Promise<{ kind: string; error: string; at: Date } | null> => {
  const failed = await prisma.job.findMany({
    where: { kind: { in: kinds }, status: "failed" },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { kind: true, lastError: true, createdAt: true, payload: true },
  });

  const mine = failed.find(job => (job.payload as { userId?: string } | null)?.userId === userId);

  return mine?.lastError ? { kind: mine.kind, error: mine.lastError, at: mine.createdAt } : null;
};

/**
 * Returns jobs abandoned by a dead worker to the queue.
 *
 * Without this a crash mid-job leaves that row `running` forever, and the work
 * simply never happens — silently, which is the worst way for a queue to fail.
 * Attempts are NOT reset: a job that reliably kills its worker should exhaust
 * its retries like any other, not loop until someone notices.
 */
export const reapStuckJobs = async (): Promise<number> => {
  const { count } = await prisma.job.updateMany({
    where: { status: "running", lockedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } },
    data: {
      status: "pending",
      lockedAt: null,
      lastError: "Reclaimed from a worker that stopped responding.",
    },
  });
  if (count) console.warn(`[queue] reclaimed ${count} stuck job(s)`);
  return count;
};
