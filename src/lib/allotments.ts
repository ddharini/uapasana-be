import type { Registration } from "@prisma/client";

import { buildStayNotice, sameNotice, type StayNotice } from "./accommodation";
import { wantsBed } from "./registrations";
import { prisma } from "../utils/db";

// PAUSED 2026-10-11 — per-person room allotment is switched off; rooms now go
// to mandals (src/lib/mandal-stays.ts). Nothing calls these any more (see the
// commented-out calls in registrationController.ts); kept to bring it back.

/**
 * Keeps room allotments in step with the registration they belong to, after
 * any change to it:
 *
 * - cancelled, or no longer asking for accommodation: every bed is freed;
 * - someone removed from the party, or no longer asking for a bed: their bed
 *   is freed.
 *
 * Anything else that stops fitting — new dates that overfill a room, a
 * registration back to pending after a devotee's edit — keeps its rooms and
 * shows up under "Needs attention" on the Accommodation screen. Nobody is
 * moved without a team member deciding it.
 */
export async function releaseStaleAllotments(registration: Registration) {
  if (registration.status === "cancelled" || !registration.accommodationRequired) {
    await prisma.roomAllotment.deleteMany({ where: { registrationId: registration.id } });
    return;
  }
  // Anyone removed from the party, or who no longer asks for a bed.
  await prisma.roomAllotment.deleteMany({
    where: {
      registrationId: registration.id,
      memberId: {
        notIn: registration.members.filter(m => wantsBed(registration, m)).map(m => m.id),
      },
    },
  });
}

/**
 * The room details to show a devotee on their own page: what they were sent,
 * and only while it is still right. Changed since, and the page says it is
 * being updated rather than showing a room they no longer have.
 */
export async function stayForDevotee(registrations: Registration[]) {
  // Sent, and still asking for a room: someone who no longer needs one (or
  // was cancelled) is not told their details are "being updated".
  const sent = registrations.filter(
    r => r.stayNoticeSentAt && r.accommodationRequired && r.status !== "cancelled"
  );
  const result = new Map<string, { notice: StayNotice | null; upToDate: boolean }>();
  if (sent.length === 0) return result;

  const [allotments, places] = await Promise.all([
    prisma.roomAllotment.findMany({ where: { registrationId: { in: sent.map(r => r.id) } } }),
    prisma.accommodationPlace.findMany(),
  ]);
  const placeMap = new Map(places.map(p => [p.id, p]));
  for (const registration of sent) {
    const current = buildStayNotice(registration, allotments, placeMap);
    const upToDate = !!current && sameNotice(current, registration.stayNotice);
    result.set(registration.id, { notice: upToDate ? current : null, upToDate });
  }
  return result;
}
