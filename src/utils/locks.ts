/**
 * Compare-and-set locks over a `DateTime?` column, and the MongoDB trap that
 * makes the obvious version of them silently never fire.
 *
 * The idiom is: claim the row with a guarded `updateMany`, and treat
 * `count === 1` as having won. It is genuinely atomic — MongoDB serialises
 * single-document writes — and it stays inside Prisma's typed client.
 *
 * **The trap.** Prisma does not write optional fields that were never given a
 * value, so a freshly created row has NO KEY for the lock at all. `findUnique`
 * still reports `null` for it, which makes the row look unlocked to every read
 * path — but `where: { lockedAt: null }` does NOT match a document whose key is
 * absent, and neither does `NOT: { lockedAt: { gte: stale } }`. Both were
 * measured against a real collection. The claim therefore matches zero rows
 * forever, and every caller is told somebody else holds a lock that does not
 * exist. A poll loop built on that will hammer the endpoint until it gives up.
 *
 * `isSet: false` is Mongo-specific and is the only clause that matches an
 * absent key, which is why it leads the list and why this lives in one place
 * rather than being retyped at each call site.
 */

/**
 * Rows whose lock is free: never set, explicitly cleared, or expired.
 *
 * Spread into a `where` alongside whatever identifies the row:
 *
 * ```ts
 * const { count } = await prisma.thing.updateMany({
 *   where: { id, ...claimable("lockedAt", LOCK_TTL_MS) },
 *   data: { lockedAt: new Date() },
 * });
 * if (count === 0) return false; // somebody else has it
 * ```
 */
export const claimable = (field: string, ttlMs: number): { OR: Record<string, unknown>[] } => ({
  OR: [
    // Must come first in spirit if not in effect: the case every other clause
    // misses, and the one a new row is always in.
    { [field]: { isSet: false } },
    { [field]: null },
    { [field]: { lt: new Date(Date.now() - ttlMs) } },
  ],
});
