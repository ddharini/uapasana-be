import { prisma } from "../utils/db";

/**
 * The usage ledger: one row per billable call to a paid third-party API.
 *
 * The point is to know what a user costs you *before* the invoice arrives. A
 * plan priced on a guess is a plan that can lose money silently for a month;
 * metering at the call site turns that into a query you can run today.
 *
 * Wired up out of the box for Anthropic (src/lib/ai/claude.ts). Call it from
 * anywhere else you spend money per request — image generation, search APIs,
 * SMS, whatever your product adds.
 */

export interface UsageRecord {
  /** A stable label for what was called, e.g. "ai:summarize". */
  endpoint: string;
  /** Who to attribute the spend to. Null for work not tied to one user. */
  userId?: string;
  /** Whatever the endpoint is billed by — tokens, images, requests. */
  units?: number;
  costUsd: number;
}

/**
 * Records one billable call. Never throws.
 *
 * Swallowing the error is deliberate and is the whole reason this is a function
 * rather than an inline `prisma.usageEvent.create`. Bookkeeping must not be able
 * to fail the work it is describing: a completion the user already paid for,
 * lost because the ledger write hit a blip, is a far worse outcome than a gap in
 * the ledger. The gap is logged, so it is visible rather than silent.
 */
export const recordUsage = async (record: UsageRecord): Promise<void> => {
  try {
    await prisma.usageEvent.create({
      data: {
        endpoint: record.endpoint,
        userId: record.userId,
        units: record.units ?? 1,
        costUsd: record.costUsd,
      },
    });
  } catch (error) {
    console.error("[usage] failed to record:", error);
  }
};

/** What one user has cost since a given instant, in USD. */
export const spendForUser = async (userId: string, since: Date): Promise<number> => {
  const events = await prisma.usageEvent.findMany({
    where: { userId, occurredAt: { gte: since } },
    select: { costUsd: true },
  });
  return events.reduce((total, event) => total + event.costUsd, 0);
};

/** Total spend across every user since a given instant — the circuit-breaker read. */
export const totalSpend = async (since: Date): Promise<number> => {
  const events = await prisma.usageEvent.findMany({
    where: { occurredAt: { gte: since } },
    select: { costUsd: true },
  });
  return events.reduce((total, event) => total + event.costUsd, 0);
};
