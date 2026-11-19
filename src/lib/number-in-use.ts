import type { Registration, RegistrationMember } from "@prisma/client";

import { statusOf } from "./event";
import { prisma } from "../utils/db";

/**
 * One mobile number, one registration.
 *
 * The one-registration-per-contact-number rule (invariant 1) only looks at the
 * contact. On 2026-11-19 the owner found Shrut Rudani twice: registered alone
 * as DM-0276 on 29 Oct, then added as a member of a family, DM-F-0194, on
 * 8 Nov, with the same number. Neither submit touched another registration's
 * CONTACT number, so nothing stopped it.
 *
 * So any number on a registration — the contact's or a family member's —
 * belongs to that registration. A family may give several of its own people
 * one phone; no other registration may use it, whoever it is typed against.
 * Matching on number + first name was built first and dropped the same day at
 * the owner's call: a number shared by two people on two registrations (a
 * mother in one family, her daughter registered alone) "ties the phone number
 * to different persons", and is refused like any other.
 *
 * Mirrored by `features/registrations/number-in-use.ts` in the frontend.
 */

/**
 * Registrations that still count: a cancelled one is not attending, so its
 * numbers are free again; dummy rows are not real people. (The contact-number
 * rule is stricter — `contactTaken` counts every registration ever.)
 */
const active = { status: { not: "cancelled" }, isSample: { not: true } };

/** Active registrations, other than `exceptId`, with anyone on one of these numbers. */
export function registrationsWithNumbers(mobiles: string[], exceptId?: string) {
  if (mobiles.length === 0) return Promise.resolve([] as Registration[]);
  return prisma.registration.findMany({
    where: {
      ...active,
      members: { some: { mobile: { in: mobiles } } },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
}

export type NumberInUse = {
  /** Index of the person in the registration being saved. */
  index: number;
  registration: Registration;
  /** Who the number is typed against there. */
  member: RegistrationMember;
};

/**
 * The people in `members` whose number is already on another active
 * registration — the first such registration and person for each.
 *
 * `kept` is the registration being edited: a number it already holds is left
 * alone, so a clash that predates this check does not stop someone fixing an
 * unrelated detail. Only a number new to it is checked.
 */
export async function numbersInUse(
  members: { mobile?: string | null }[],
  kept?: Pick<Registration, "id" | "members">
): Promise<NumberInUse[]> {
  const own = new Set(kept?.members.map((m) => m.mobile).filter(Boolean));
  const checked = members
    .map((person, index) => ({ mobile: person.mobile, index }))
    .filter((p): p is { mobile: string; index: number } => !!p.mobile && !own.has(p.mobile));
  const others = await registrationsWithNumbers([...new Set(checked.map((p) => p.mobile))], kept?.id);

  return checked.flatMap(({ mobile, index }) => {
    for (const registration of others) {
      const member = registration.members.find((m) => m.mobile === mobile);
      if (member) return [{ index, registration, member }];
    }
    return [];
  });
}

/**
 * Where a number is already used. Two depths: `withDetails` (the person's own
 * arrival and leaving, mandal, status) only for someone who has proved the
 * number with a code; a refused submit carries just enough to recognise it.
 */
export function toNumberUseSummary(registration: Registration, member: RegistrationMember, withDetails: boolean) {
  const contact = registration.members[0];
  return {
    code: registration.code,
    type: registration.type,
    name: registration.groupName ?? contact?.fullName ?? "",
    contactName: contact?.fullName ?? "",
    personCode: member.code ?? null,
    personName: member.fullName,
    mobile: member.mobile ?? null,
    ...(withDetails
      ? {
          id: registration.id,
          mandal: registration.mandal,
          status: statusOf(registration.status),
          arrival: { date: member.arrival.date, slot: member.arrival.slot },
          departure: { date: member.departure.date, slot: member.departure.slot },
        }
      : {}),
  };
}
