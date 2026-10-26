import { Request, Response } from "express";

import { z } from "zod";
import { Prisma, type Registration } from "@prisma/client";

import { MOBILE_E164 } from "../lib/event";
// PAUSED 2026-10-11 — per-person room allotment (rooms now go to mandals).
// import { releaseStaleAllotments, stayForDevotee } from "../lib/allotments";
import { MOBILE_OTP_REQUIRED, consumeVerificationToken, peekVerificationToken } from "../lib/otp";
import { takeNumbers, withCodes } from "../lib/registration-codes";
import { recordChange } from "../lib/registration-changes";
import { confirmationLang, sendRegistrationConfirmation } from "../lib/registration-confirmation";
import {
  newRegistrationSchema,
  statusSchema,
  toCreateData,
  toRegistrationDto,
  toRegistrationSummary,
  type NewRegistrationInput,
} from "../lib/registrations";
import { DESK_ROLES, IN_PERSON_ROLES, registrationScope } from "../middlewares/authMiddleware";
import { prisma } from "../utils/db";

/**
 * Registrations for the event.
 *
 * Public (no account): `create` — the devotee form — and the devotee's own
 * `mine` / `updateSelf`, both proven by an OTP on the primary contact's number.
 * Everything else runs behind `protect` + `requireStaff`, scoped to one mandal
 * for a sanchalak (`registrationScope`); status changes also need
 * `requireReviewer`.
 */

/** Answers 400 with every field problem, in the shape the frontend can show. */
function validationError(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  res.status(400).json({
    success: false,
    code: "VALIDATION_ERROR",
    message: issues[0]?.message ?? "Some details are missing or invalid.",
    errors: issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

/** Prisma rejects a malformed ObjectId with an error, not a null, so it is checked first. */
const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);

const notFound = (res: Response) =>
  res.status(404).json({ success: false, code: "NOT_FOUND", message: "Registration not found" });

/** The registration whose contact uses this number — at most one. */
const byPrimaryMobile = (mobile: string) => ({ contactMobile: mobile });

/** A sanchalak registers and edits only their own mandal. Answers 403 and returns false otherwise. */
function withinMandal(req: Request, res: Response, mandal: string): boolean {
  if (req.user?.role !== "sanchalak" || req.user.mandal === mandal) return true;
  res.status(403).json({
    success: false,
    code: "WRONG_MANDAL",
    message: `You can register and edit people from ${req.user.mandal ?? "your mandal"} only.`,
    errors: [{ path: "mandal", message: `Only ${req.user.mandal ?? "your mandal"}` }],
  });
  return false;
}

/**
 * One registration per contact number. Answers 409 ALREADY_REGISTERED and
 * returns true when `mobile` is already the contact of another registration
 * (other than `exceptId`, the one being edited). Checked before anything is
 * spent; the unique index on `contactMobile` backs it up against two submits
 * racing (see `isDuplicateContact`).
 */
async function contactTaken(req: Request, res: Response, mobile: string | null | undefined, exceptId?: string) {
  if (!mobile) return false;
  const existing = await prisma.registration.findFirst({
    where: { contactMobile: mobile, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (!existing) return false;
  alreadyRegistered(req, res, existing);
  return true;
}

function alreadyRegistered(req: Request, res: Response, existing: Registration) {
  const scope = registrationScope(req.user);
  const atDesk = DESK_ROLES.has(req.user?.role);
  res.status(409).json({
    success: false,
    code: "ALREADY_REGISTERED",
    message: `This number is already registered (${existing.code}). Each contact number has one registration — change that one instead.`,
    errors: [{ path: "members.0.mobile", message: `Already registered as ${existing.code}` }],
    registration: toRegistrationSummary(existing, atDesk && (!("mandal" in scope) || existing.mandal === scope.mandal)),
  });
}

/** Prisma's unique-violation, on the contact-number index: two submits raced. */
const isDuplicateContact = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

type Verification = { mobileVerification: string | null; verifiedByName: string | null };

/**
 * How the primary contact's number is vouched for, checked last so nothing is
 * spent on a request that fails for another reason:
 *
 * - unchanged from `keptMobile` (an edit that keeps the contact): nothing to do;
 * - `verifiedInPerson`: a sanchalak or admin at the desk vouches for it;
 * - otherwise an unused OTP token for this very number, which is spent here —
 *   unless codes are switched off (MOBILE_OTP_REQUIRED), when it is recorded
 *   as unverified.
 *
 * Returns what to record, "unchanged", or null after answering the request.
 */
async function verifyPrimaryMobile(
  req: Request,
  res: Response,
  input: NewRegistrationInput,
  keptMobile?: string
): Promise<Verification | "unchanged" | null> {
  const mobile = input.members[0]?.mobile;
  if (keptMobile && mobile === keptMobile) return "unchanged";

  if (input.verifiedInPerson) {
    if (!IN_PERSON_ROLES.has(req.user?.role)) {
      res.status(403).json({
        success: false,
        code: "IN_PERSON_NOT_ALLOWED",
        message: "Only a sanchalak or an admin can verify a number in person.",
      });
      return null;
    }
    return { mobileVerification: "in_person", verifiedByName: req.user.name };
  }

  if (!MOBILE_OTP_REQUIRED) return { mobileVerification: null, verifiedByName: null };

  const token = input.mobileVerificationToken;
  if (mobile && token && (await consumeVerificationToken(token, mobile))) {
    return { mobileVerification: "otp", verifiedByName: null };
  }
  res.status(400).json({
    success: false,
    code: "MOBILE_NOT_VERIFIED",
    message: "The primary contact's mobile number needs to be verified. Send a new code and try again.",
    errors: [{ path: "members.0.mobile", message: "Verify this number" }],
  });
  return null;
}

const create = async (req: Request, res: Response): Promise<void> => {
  const parsed = newRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  if (!withinMandal(req, res, parsed.data.mandal)) return;
  if (await contactTaken(req, res, parsed.data.members[0]?.mobile)) return;

  const verification = await verifyPrimaryMobile(req, res, parsed.data);
  if (!verification || verification === "unchanged") return;

  // A team member at the desk, or a devotee on the public form. Only a desk
  // role counts: a plain signed-in account is still "self".
  const atDesk = DESK_ROLES.has(req.user?.role);
  const [sequence] = await takeNumbers("registration", 1);

  let registration: Registration;
  try {
    registration = await prisma.registration.create({
      data: {
        ...(await withCodes(toCreateData(parsed.data))),
        ...verification,
        sequence,
        status: "confirmed",
        source: atDesk ? "staff" : "self",
        createdById: atDesk ? req.user.id : null,
      },
    });
  } catch (error) {
    // Someone registered this number in the instant since the check above.
    if (isDuplicateContact(error) && (await contactTaken(req, res, parsed.data.members[0]?.mobile))) return;
    throw error;
  }

  res.status(201).json({ success: true, data: toRegistrationDto(registration) });
  // After answering: a slow or refused WhatsApp send must not hold up, or
  // fail, a registration that is already saved. `lang` is the language the
  // form was shown in; the desk's screens are English.
  void sendRegistrationConfirmation(registration, confirmationLang(req.body?.lang));
};

/**
 * Every registration the viewer may see, newest first — one mandal's for a
 * sanchalak.
 *
 * Unpaged on purpose for now: the overview's headcounts are worked out from the
 * whole list in the browser, and an event of this size is a few thousand rows
 * at most. Move the counting here and page this once it is not.
 */
const list = async (req: Request, res: Response): Promise<void> => {
  const registrations = await prisma.registration.findMany({
    where: registrationScope(req.user),
    orderBy: { createdAt: "desc" },
  });
  res.status(200).json({ success: true, data: registrations.map(toRegistrationDto) });
};

const getOne = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const registration = isObjectId(id)
    ? await prisma.registration.findFirst({ where: { id, ...registrationScope(req.user) } })
    : null;
  if (!registration) return void notFound(res);
  res.status(200).json({ success: true, data: toRegistrationDto(registration) });
};

/**
 * The registration whose contact uses `mobile`, if any — one per number — so
 * the desk form can stop before a second one is filled in. Reported even from
 * another mandal (the number is still taken); `id`, to open it, only when the
 * viewer may. `exclude` leaves out the registration being edited.
 */
const lookup = async (req: Request, res: Response): Promise<void> => {
  const mobile = String(req.query.mobile ?? "");
  if (!MOBILE_E164.test(mobile)) {
    res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Give a mobile number with country code" });
    return;
  }
  const exclude = String(req.query.exclude ?? "");
  const matches = await prisma.registration.findMany({
    where: { ...byPrimaryMobile(mobile), ...(isObjectId(exclude) ? { id: { not: exclude } } : {}) },
    orderBy: { createdAt: "desc" },
  });
  const scope = registrationScope(req.user);
  res.status(200).json({
    success: true,
    data: matches.map((r) => toRegistrationSummary(r, !("mandal" in scope) || r.mandal === scope.mandal)),
  });
};

/**
 * Public: whether a number is already some registration's contact, so the
 * devotee form can say so as soon as the number is complete — before a code
 * is sent that could only lead to "already registered". Yes or no and nothing
 * else: no code, name or mandal reaches anyone who has not proved the number
 * is theirs (POST /otp/verify returns those).
 */
const taken = async (req: Request, res: Response): Promise<void> => {
  const mobile = String(req.query.mobile ?? "");
  if (!MOBILE_E164.test(mobile)) {
    res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Give a mobile number with country code" });
    return;
  }
  const count = await prisma.registration.count({ where: byPrimaryMobile(mobile) });
  res.status(200).json({ success: true, data: { taken: count > 0 } });
};

const setStatus = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  const exists = isObjectId(id) && (await prisma.registration.count({ where: { id } })) > 0;
  if (!exists) return void notFound(res);

  const registration = await prisma.registration.update({
    where: { id },
    data: { status: parsed.data.status },
  });
  // await releaseStaleAllotments(registration); // paused: per-person allotment
  res.status(200).json({ success: true, data: toRegistrationDto(registration) });
};

/**
 * A team member changing a registration's details. The status stays as it
 * is; changing the contact's number needs it verified again (OTP, or in
 * person for a sanchalak or admin).
 */
const update = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const existing = isObjectId(id)
    ? await prisma.registration.findFirst({ where: { id, ...registrationScope(req.user) } })
    : null;
  if (!existing) return void notFound(res);

  const parsed = newRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  if (!withinMandal(req, res, parsed.data.mandal)) return;

  if (await contactTaken(req, res, parsed.data.members[0]?.mobile, id)) return;
  const verification = await verifyPrimaryMobile(req, res, parsed.data, existing.members[0]?.mobile ?? undefined);
  if (!verification) return;

  let registration: Registration;
  try {
    registration = await prisma.registration.update({
      where: { id },
      data: {
        ...(await withCodes(toCreateData(parsed.data, existing.members.map((m) => m.id)), existing)),
        ...(verification === "unchanged" ? {} : verification),
        editedAt: new Date(),
        editedByName: req.user.name,
      },
    });
  } catch (error) {
    if (isDuplicateContact(error) && (await contactTaken(req, res, parsed.data.members[0]?.mobile, id))) return;
    throw error;
  }
  // await releaseStaleAllotments(registration); // paused: per-person allotment
  await recordChange(existing, registration, { by: "team", name: req.user.name, userId: req.user.id });
  res.status(200).json({ success: true, data: toRegistrationDto(registration) });
};

const mineSchema = z.object({
  mobile: z.string().regex(MOBILE_E164, "Enter a valid mobile number with country code"),
  token: z.string().min(1),
});

/**
 * Public: the registrations a devotee made, for editing. Proven by an OTP
 * token for the number (from POST /otp/verify), which is only checked here —
 * the edit that follows spends it.
 */
const mine = async (req: Request, res: Response): Promise<void> => {
  const parsed = mineSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const { mobile, token } = parsed.data;
  if (!(await peekVerificationToken(token, mobile))) {
    res.status(401).json({ success: false, code: "MOBILE_NOT_VERIFIED", message: "Verify your number again to see your registrations." });
    return;
  }
  const registrations = await prisma.registration.findMany({
    where: byPrimaryMobile(mobile),
    orderBy: { createdAt: "desc" },
  });
  res.status(200).json({ success: true, data: registrations.map(toRegistrationDto) });
  // PAUSED 2026-10-11 — per-person allotment: their room details, once sent,
  // or that they are being updated.
  //
  // const stays = await stayForDevotee(registrations);
  // res.status(200).json({
  //   success: true,
  //   data: registrations.map((r) => {
  //     const stay = stays.get(r.id);
  //     return {
  //       ...toRegistrationDto(r),
  //       ...(stay ? { stay: stay.notice ?? undefined, stayChanging: !stay.upToDate } : {}),
  //     };
  //   }),
  // });
};

/** Statuses a devotee can no longer edit online: they are at the event, or it was called off. */
const LOCKED_FOR_SELF = new Set(["checked_in", "cancelled"]);

/**
 * Public: a devotee editing their own registration, proven by an OTP token for
 * its primary contact's number (spent here). The contact number itself stays
 * — changing it is for the desk. The status stays as it is; every change is logged for admins (Logs screen) instead.
 */
const updateSelf = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const existing = isObjectId(id) ? await prisma.registration.findUnique({ where: { id } }) : null;
  if (!existing) return void notFound(res);

  if (LOCKED_FOR_SELF.has(existing.status)) {
    res.status(409).json({
      success: false,
      code: "NOT_EDITABLE",
      message:
        existing.status === "checked_in"
          ? "You are already checked in. Ask at the registration desk to change anything."
          : "This registration was cancelled. Contact your mandal sanchalak to restore it.",
    });
    return;
  }

  const parsed = newRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  const ownerMobile = existing.members[0]?.mobile;
  if (!ownerMobile || parsed.data.members[0]?.mobile !== ownerMobile) {
    res.status(400).json({
      success: false,
      code: "CONTACT_LOCKED",
      message: "The primary contact's number cannot be changed online. Ask your mandal sanchalak or the desk.",
      errors: [{ path: "members.0.mobile", message: "Cannot be changed here" }],
    });
    return;
  }
  const token = parsed.data.mobileVerificationToken;
  if (!token || !(await consumeVerificationToken(token, ownerMobile))) {
    res.status(400).json({
      success: false,
      code: "MOBILE_NOT_VERIFIED",
      message: "Verify your number again to save these changes.",
    });
    return;
  }

  const registration = await prisma.registration.update({
    where: { id },
    data: {
      ...(await withCodes(toCreateData(parsed.data, existing.members.map((m) => m.id)), existing)),
      editedAt: new Date(),
      editedByName: "the devotee",
    },
  });
  // await releaseStaleAllotments(registration); // paused: per-person allotment
  await recordChange(existing, registration, { by: "devotee" });
  res.status(200).json({ success: true, data: toRegistrationDto(registration) });
};

export const registrationController = { create, list, getOne, lookup, taken, setStatus, update, mine, updateSelf };
