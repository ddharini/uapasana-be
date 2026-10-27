import express from "express";

import { registrationController } from "../controllers/registrationController";
import { optionalSession, protect, requireReviewer, requireStaff } from "../middlewares/authMiddleware";

export const registrationRouter = express.Router();

const { create, list, getOne, lookup, taken, setStatus, update, mine, updateSelf, pdf } =
  registrationController;

/**
 * @openapi
 * tags:
 *   name: Registrations
 *   description: Event registrations — public submission, staff-only everything else
 */

/**
 * @openapi
 * /registrations:
 *   post:
 *     summary: Submit a registration
 *     description: >
 *       Public: devotees register from the shared form without an account. A
 *       request carrying a staff session is recorded with `source: "staff"`,
 *       anything else as `"self"`. The server assigns the code, status and
 *       timestamps. Optional `lang` (`en` | `gu`) picks the language of the
 *       WhatsApp confirmation sent to the contact once it is saved.
 *     tags: [Registrations]
 *     responses:
 *       201:
 *         description: The stored registration, with its code
 *       400:
 *         description: VALIDATION_ERROR, with every field problem in `errors`
 */
registrationRouter.post("/", optionalSession, create);

/**
 * @openapi
 * /registrations/mine:
 *   post:
 *     summary: A devotee's own registrations, to edit
 *     description: >
 *       Public. `{ mobile, token }`, the token from POST /otp/verify for that
 *       number. Returns every registration whose primary contact uses it. The
 *       token is checked, not spent — the edit spends it.
 *     tags: [Registrations]
 *     responses:
 *       200:
 *         description: The registrations
 *       401:
 *         description: MOBILE_NOT_VERIFIED
 */
registrationRouter.post("/mine", mine);

/**
 * @openapi
 * /registrations/{id}/self:
 *   patch:
 *     summary: A devotee editing their own registration
 *     description: >
 *       Public. The full registration plus `mobileVerificationToken` for its
 *       primary contact's number (spent). The contact number cannot change
 *       here. The status is kept; the change is logged for admins.
 *     tags: [Registrations]
 *     responses:
 *       200:
 *         description: The updated registration
 *       400:
 *         description: VALIDATION_ERROR, CONTACT_LOCKED or MOBILE_NOT_VERIFIED
 *       409:
 *         description: NOT_EDITABLE — checked in or cancelled
 */
registrationRouter.patch("/:id/self", updateSelf);

/**
 * @openapi
 * /registrations/taken:
 *   get:
 *     summary: Whether a number is already a registration's contact
 *     description: >
 *       Public. `?mobile=+91…`. Lets the devotee form say "already registered"
 *       as soon as the number is complete, before a code is sent. Answers yes
 *       or no only — the registration's details come from POST /otp/verify,
 *       once the number is proved.
 *     tags: [Registrations]
 *     responses:
 *       200:
 *         description: "`{ taken }`"
 *       400:
 *         description: VALIDATION_ERROR — not a mobile number with country code
 */
registrationRouter.get("/taken", taken);

/**
 * @openapi
 * /registrations/pdf/{token}:
 *   get:
 *     summary: A registration as a PDF, from the link in its WhatsApp confirmation
 *     description: >
 *       Public. The token is the registration's id and a signature of it
 *       (`<id>-<signature>`, optionally ending ".pdf"), so it opens only the
 *       registration it was made for. Rendered on every request.
 *     tags: [Registrations]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The PDF
 *         content:
 *           application/pdf: {}
 *       404:
 *         description: NOT_FOUND — not a token this server signed, or the registration is gone
 */
registrationRouter.get("/pdf/:token", pdf);

// Everything below holds devotees' personal details: the desk only, and a
// sanchalak only for their mandal.
registrationRouter.use(protect, requireStaff);

/**
 * @openapi
 * /registrations:
 *   get:
 *     summary: Every registration, newest first
 *     tags: [Registrations]
 *     responses:
 *       200:
 *         description: All registrations
 *       401:
 *         description: Not signed in
 *       403:
 *         description: NOT_STAFF — signed in without the staff role
 */
registrationRouter.get("/", list);

/**
 * @openapi
 * /registrations/lookup:
 *   get:
 *     summary: Registrations whose primary contact uses a number
 *     description: >
 *       For the "already registered" warning. `?mobile=+91…&exclude=<id>`.
 *       Every match is listed; `id` only for those the viewer may open.
 *     tags: [Registrations]
 *     responses:
 *       200:
 *         description: Summaries — code, name, people, status, mandal
 */
registrationRouter.get("/lookup", lookup);

/**
 * @openapi
 * /registrations/{id}:
 *   get:
 *     summary: One registration
 *     tags: [Registrations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The registration
 *       404:
 *         description: NOT_FOUND
 */
registrationRouter.get("/:id", getOne);

/**
 * @openapi
 * /registrations/{id}/status:
 *   patch:
 *     summary: Check in, cancel or restore a registration
 *     tags: [Registrations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [confirmed, checked_in, cancelled]
 *                 description: confirmed is shown as "Registered"
 *     responses:
 *       200:
 *         description: The updated registration
 *       404:
 *         description: NOT_FOUND
 */
registrationRouter.patch("/:id/status", requireReviewer, setStatus);

/**
 * @openapi
 * /registrations/{id}:
 *   patch:
 *     summary: Edit a registration at the desk
 *     description: >
 *       The full registration. Status is kept. Changing the primary contact's
 *       number needs `mobileVerificationToken` for the new one, or
 *       `verifiedInPerson` from a sanchalak or admin. The change is logged
 *       for admins.
 *     tags: [Registrations]
 *     responses:
 *       200:
 *         description: The updated registration
 *       403:
 *         description: WRONG_MANDAL or IN_PERSON_NOT_ALLOWED
 *       404:
 *         description: NOT_FOUND (or outside a sanchalak's mandal)
 */
registrationRouter.patch("/:id", update);
