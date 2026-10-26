import type { Prisma, Registration, RegistrationChange } from "@prisma/client";

import { prisma } from "../utils/db";
import { statusOf } from "./event";
import { toRegistrationDto } from "./registrations";

/**
 * The change log: every edit made to a registration after it was submitted,
 * for admins to look back on (Logs screen, GET /admin/registration-changes).
 */

/** The details a form edit can change, in the shape the frontend reads. */
export function detailsOf(r: Registration) {
  const { type, groupName, mandal, members, arrival, departure, travel, indiaTravel, accommodationRequired, earlySeva, notes } =
    toRegistrationDto(r);
  return { type, groupName, mandal, members, arrival, departure, travel, indiaTravel, accommodationRequired, earlySeva, notes };
}

/** JSON with object keys sorted, so two equal snapshots always compare equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

type Author = { by: "devotee" } | { by: "team"; name: string; userId: string };

/**
 * Logs an edit, from the registration as it was and as saved. A save that
 * changed nothing is not logged. Never fails the edit it records: the edit
 * is already saved, so a failure here is reported and swallowed.
 */
export async function recordChange(before: Registration, after: Registration, author: Author) {
  const previous = detailsOf(before);
  const next = detailsOf(after);
  if (stableJson(previous) === stableJson(next)) return;

  try {
    await prisma.registrationChange.create({
      data: {
        registrationId: after.id,
        code: after.code,
        name: after.groupName ?? after.members[0]?.fullName ?? "",
        mandal: after.mandal,
        by: author.by,
        byName: author.by === "team" ? author.name : null,
        byUserId: author.by === "team" ? author.userId : null,
        status: after.status,
        // Plain JSON already; the cast only satisfies Prisma's Json input type.
        before: previous as unknown as Prisma.InputJsonValue,
        after: next as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    console.error(`Could not log the change to ${after.code}`, error);
  }
}

/** A log entry as the frontend reads it. */
export function toChangeDto(c: RegistrationChange) {
  return {
    id: c.id,
    registrationId: c.registrationId,
    code: c.code,
    name: c.name,
    mandal: c.mandal,
    by: c.by,
    byName: c.byName ?? undefined,
    status: statusOf(c.status),
    before: c.before,
    after: c.after,
    createdAt: c.createdAt.toISOString(),
  };
}
