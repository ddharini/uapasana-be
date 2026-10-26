// Must stay the first import — see src/env.ts.
import "../env";

import { prisma } from "../utils/db";
import { claimJob, completeJob, failJob, reapStuckJobs, type ClaimedJob } from "../lib/queue/claim";
import { AiError } from "../lib/ai/claude";

/**
 * The background worker.
 *
 * **Its own process, not a timer inside the API.** Background work is typically
 * slow and rate-limited — third-party calls, model calls, batch writes — and
 * running that inside the request-serving process means one user's long job
 * makes every other user's page slow. It also has to keep running when nobody
 * has the app open, which is the entire point of scheduling.
 *
 * Distinct from `scripts/*.ts`, which are one-shot maintenance tasks fired by
 * external cron and exit. This never exits.
 *
 * Start it with `pnpm worker` in development, `pnpm worker:start` in production,
 * and deploy it as a separate service from the API.
 */

const POLL_INTERVAL_MS = 5000;
/** Reaping is cheap but not free; once a minute is plenty. */
const REAP_EVERY_MS = 60_000;

let shuttingDown = false;
let activeJob: string | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Routes a claimed job to whatever does the work.
 *
 * This is where you register a new job kind — add a `case` here and a member to
 * `JobKind` in src/lib/queue/claim.ts. The cast from the queue's untyped `Json`
 * payload happens here and nowhere else, so handlers take real types.
 *
 * An unknown kind throws permanently rather than retrying: the job was written
 * by a version of the code that knew something this one does not, and five
 * retries will not teach it.
 */
const dispatch = async (job: ClaimedJob): Promise<void> => {
  switch (job.kind) {
    default:
      throw new UnknownJobKind(job.kind);
  }
};

class UnknownJobKind extends Error {
  constructor(kind: string) {
    super(`No handler for job kind "${kind}"`);
    this.name = "UnknownJobKind";
  }
}

/**
 * Whether an error is worth trying again, and when.
 *
 * Extend this as you add handlers. The `retryAt` case is the one that earns its
 * keep: an upstream that names the exact second its rate-limit window reopens
 * beats any exponential guess — too short burns an attempt on a call that cannot
 * succeed, too long leaves the work late for no reason.
 *
 * Default is "retry", on the reasoning that an unrecognised error is more often
 * a blip than a bug.
 */
const classify = (error: unknown): { permanent: boolean; retryAt?: Date } => {
  if (error instanceof UnknownJobKind) return { permanent: true };
  if (error instanceof AiError) return { permanent: error.permanent };
  return { permanent: false };
};

const runOnce = async (): Promise<boolean> => {
  const job = await claimJob();
  if (!job) return false;

  activeJob = job.id;
  const started = Date.now();
  console.log(`[worker] ${job.kind} ${job.id} (attempt ${job.attempts}/${job.maxAttempts})`);

  try {
    await dispatch(job);
    await completeJob(job.id);
    console.log(`[worker] ${job.kind} ${job.id} done in ${Date.now() - started}ms`);
  } catch (error) {
    const { permanent, retryAt } = classify(error);
    const { willRetry, nextRunAt } = await failJob(job, error, { permanent, retryAt });

    console.error(
      `[worker] ${job.kind} ${job.id} failed: ${(error as Error).message}` +
        (willRetry ? ` — retrying at ${nextRunAt?.toISOString()}` : " — giving up")
    );
  } finally {
    activeJob = null;
  }

  return true;
};

const main = async (): Promise<void> => {
  await prisma.$connect();
  console.log("✅ Worker connected to the database");
  console.log(`✅ Polling every ${POLL_INTERVAL_MS / 1000}s`);

  let lastReap = 0;

  while (!shuttingDown) {
    try {
      if (Date.now() - lastReap > REAP_EVERY_MS) {
        await reapStuckJobs();
        lastReap = Date.now();
      }

      // Drain rather than sleeping between jobs: a backlog should clear as fast
      // as the handlers allow, not at one job per poll interval.
      let didWork = await runOnce();
      while (didWork && !shuttingDown) didWork = await runOnce();
    } catch (error) {
      // The loop itself must never die. A database blip should mean a pause,
      // not a worker that silently stops and takes every scheduled job with it.
      console.error("[worker] loop error:", error);
    }

    if (!shuttingDown) await sleep(POLL_INTERVAL_MS);
  }
};

/**
 * Stops taking new work and lets the current job finish.
 *
 * Killing mid-job would be survivable — `reapStuckJobs` returns it to the queue
 * after fifteen minutes — but a handler interrupted between an external call and
 * the write that records it is exactly the case that costs a duplicate.
 */
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${signal} — finishing ${activeJob ? `job ${activeJob}` : "up"} then exiting`);

  const deadline = Date.now() + 30_000;
  while (activeJob && Date.now() < deadline) await sleep(200);

  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch(async error => {
  console.error("Worker failed to start:", error);
  await prisma.$disconnect();
  process.exit(1);
});
