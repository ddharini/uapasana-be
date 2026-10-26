import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

/**
 * Query logging is opt-in via `PRISMA_LOG_QUERIES=1`, not on by default.
 *
 * It used to be unconditional, which was tolerable while the only consumer was
 * an API serving a handful of requests a minute in development. The background
 * worker changed that: it polls the job table every five seconds forever, so
 * unconditional logging buries every real line — a completed import, a failed
 * publish — under hundreds of aggregate pipelines, and in production writes the
 * contents of user records to stdout for a log aggregator to keep.
 *
 * Warnings and errors always come through. Those are the ones worth seeing.
 */
const log: ("query" | "warn" | "error")[] =
  process.env.PRISMA_LOG_QUERIES === "1" ? ["query", "warn", "error"] : ["warn", "error"];

export const prisma = globalForPrisma.prisma || new PrismaClient({ log });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
