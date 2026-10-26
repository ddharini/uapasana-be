import express from "express";
import { adminController } from "../controllers/adminController";
import { adminUsersController } from "../controllers/adminUsersController";
import { adminInvitesController } from "../controllers/adminInvitesController";
import { adminSampleDataController } from "../controllers/adminSampleDataController";
import { registrationChangesController } from "../controllers/registrationChangesController";
import { assistantController } from "../controllers/assistantController";
import { adminWhatsAppController } from "../controllers/adminWhatsAppController";
import { adminBroadcastsController } from "../controllers/adminBroadcastsController";
import { protect, requireAdmin } from "../middlewares/authMiddleware";

export const adminRouter = express.Router();

const { getMe } = adminController;

/**
 * @openapi
 * tags:
 *   name: Admin
 *   description: Admin-only endpoints, gated by an admin role on the caller
 */

// Every route below requires both a valid session AND an admin role. There is
// no self-serve way to acquire that role — see the comment on `User.role` in
// schema.prisma.
adminRouter.use(protect, requireAdmin);

/**
 * @openapi
 * /admin/me:
 *   get:
 *     summary: The signed-in admin's own record
 *     description: >
 *       Cheap way for the admin panel to confirm the session it holds is both
 *       valid and actually admin — a 403 here means the account is signed in
 *       but not promoted, distinct from a 401 meaning not signed in at all.
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: The admin user
 *       401:
 *         description: Not signed in
 *       403:
 *         description: Signed in but not an admin
 */
adminRouter.get("/me", getMe);

/**
 * @openapi
 * tags:
 *   name: Admin Users
 *   description: Read-only user list and detail — accounts, status and activity history
 */
const { listAll: listUsers, getOne: getUser } = adminUsersController;

/**
 * @openapi
 * /admin/users:
 *   get:
 *     summary: List users, filterable and paginated
 *     tags: [Admin Users]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Matches name or email, case-insensitive
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [user, admin] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, deleted] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: A page of users
 */
adminRouter.get("/users", listUsers);

/**
 * @openapi
 * /admin/users/{id}:
 *   get:
 *     summary: One user's profile and account activity history
 *     tags: [Admin Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The user
 *       404:
 *         description: Unknown user id (`UNKNOWN_USER`)
 */
adminRouter.get("/users/:id", getUser);

/**
 * @openapi
 * tags:
 *   name: Admin Team
 *   description: Who the admins are, and inviting more of them
 */
const { listTeam, createInvite, revokeInvite } = adminInvitesController;

/**
 * @openapi
 * /admin/team:
 *   get:
 *     summary: Current admins and pending invites
 *     tags: [Admin Team]
 *     responses:
 *       200:
 *         description: "`{ admins, invites, delivery }` — admins oldest first, pending invites newest first, and whether email and WhatsApp sending are configured"
 */
adminRouter.get("/team", listTeam);

/**
 * @openapi
 * /admin/invites:
 *   post:
 *     summary: Invite someone to be an admin, by email or mobile
 *     description: >
 *       Creates a single-use link that expires in 7 days and revokes any earlier
 *       pending link for the same address, then sends it — by email (Resend)
 *       or on WhatsApp (Meta Cloud API). The `url` is always returned so the admin can
 *       share it themselves; `sent` says whether the server delivered it and
 *       `notSentReason` (not_configured | failed) why not.
 *     tags: [Admin Team]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 properties:
 *                   channel: { type: string, enum: [email] }
 *                   email: { type: string }
 *                   name: { type: string }
 *               - type: object
 *                 properties:
 *                   channel: { type: string, enum: [mobile] }
 *                   mobile: { type: string, description: "E.164, e.g. +919876543210" }
 *                   name: { type: string }
 *     responses:
 *       201:
 *         description: "`{ invite, url, sent, notSentReason? }`"
 *       400:
 *         description: VALIDATION_ERROR
 *       409:
 *         description: ALREADY_ADMIN — that email already belongs to an admin
 */
adminRouter.post("/invites", createInvite);

/**
 * @openapi
 * /admin/invites/{id}:
 *   delete:
 *     summary: Revoke a pending invite
 *     tags: [Admin Team]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Revoked
 *       404:
 *         description: NOT_FOUND — no pending invite with that id
 */
adminRouter.delete("/invites/:id", revokeInvite);

const {
  status: sampleDataStatus,
  add: addSampleData,
  remove: removeSampleData,
} = adminSampleDataController;

/**
 * @openapi
 * /admin/sample-data:
 *   get:
 *     summary: How many dummy registrations are loaded
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`{ count, total }`"
 *   post:
 *     summary: Load the dummy registrations
 *     description: Adds any of the 64 samples that are missing. Real registrations are not touched.
 *     tags: [Admin]
 *     responses:
 *       201:
 *         description: "`{ added, count }`"
 *       409:
 *         description: SAMPLE_CODES_TAKEN — a real registration holds a sample code
 *   delete:
 *     summary: Remove the dummy registrations
 *     description: Deletes only registrations flagged as samples.
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`{ removed, count }`"
 */
adminRouter.get("/sample-data", sampleDataStatus);
adminRouter.post("/sample-data", addSampleData);
adminRouter.delete("/sample-data", removeSampleData);

/**
 * @openapi
 * /admin/registration-changes:
 *   get:
 *     summary: The change log — edits to registrations after they were submitted
 *     description: >
 *       Newest first, 50 a page. Each entry has who made the edit (`by`:
 *       devotee or team, with `byName`), the status at the time, and the
 *       registration's details `before` and `after`.
 *     tags: [Admin]
 *     parameters:
 *       - in: query
 *         name: by
 *         schema: { type: string, enum: [devotee, team] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Matches the registration code or name, case-insensitive
 *       - in: query
 *         name: registration
 *         schema: { type: string }
 *         description: One registration's id
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: "`{ changes, total, page, pageSize }`"
 */
adminRouter.get("/registration-changes", registrationChangesController.list);

/**
 * @openapi
 * /admin/whatsapp/messages:
 *   get:
 *     summary: WhatsApp messages we sent, and what became of each
 *     description: >
 *       Newest first, 50 a page. Only sends Meta accepted are here; `status`
 *       moves accepted → sent → delivered → read, or to failed with Meta's
 *       `errorCode` / `errorMessage`, as the webhook reports.
 *     tags: [Admin]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [accepted, sent, delivered, read, failed] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Part of the number; non-digits are ignored
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: "`{ messages, total, page, pageSize }`"
 */
adminRouter.get("/whatsapp/messages", adminWhatsAppController.listMessages);

/**
 * @openapi
 * /admin/whatsapp/replies:
 *   get:
 *     summary: Messages devotees sent to our WhatsApp number
 *     description: >
 *       Newest first, 50 a page, with the registration whose contact the
 *       number is when one matches. The number is not on any phone, so this is
 *       the only place replies can be read.
 *     tags: [Admin]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Part of the number; non-digits are ignored
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: "`{ replies, total, page, pageSize }`"
 */
adminRouter.get("/whatsapp/replies", adminWhatsAppController.listReplies);

/**
 * @openapi
 * tags:
 *   name: Send messages
 *   description: One WhatsApp template to many registered devotees (admin only)
 */

/**
 * @openapi
 * /admin/broadcasts/templates:
 *   get:
 *     summary: Templates that can be sent from Send messages, with prices and limits
 *     description: >
 *       Approved Utility and Marketing templates whose blanks are in the body
 *       only, grouped by name with each language's body and blank count. Also
 *       `announcement` (the free-text template's name), `sources` (what can fill
 *       a blank), `priceInr` per category, `dailyLimit`, `maxRecipients`,
 *       `maxTextLength`.
 *     tags: [Send messages]
 *     responses:
 *       200: { description: The templates }
 *       502: { description: TEMPLATES_UNAVAILABLE — Meta did not answer }
 *       503: { description: WHATSAPP_NOT_CONFIGURED }
 */
adminRouter.get("/broadcasts/templates", adminBroadcastsController.templates);

/**
 * @openapi
 * /admin/broadcasts:
 *   get:
 *     summary: Past sends, newest first, 50 a page
 *     tags: [Send messages]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *     responses:
 *       200: { description: "`{ broadcasts, total, page, pageSize }`" }
 *   post:
 *     summary: Send a template to the people picked — or, with dryRun, only count them
 *     description: >
 *       Numbers are read from the registrations on the server; dummy
 *       registrations, people without a number and repeated numbers are left
 *       out (`skipped`). Sending happens in the background, ~6 a second, and
 *       pauses after 10 failures in a row.
 *     tags: [Send messages]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [template, language, variables, picks]
 *             properties:
 *               template: { type: string }
 *               language: { type: string, example: en }
 *               variables:
 *                 type: array
 *                 description: "One per blank: `{ source: name | firstName | dmNumber | registrationNumber | mandal }` or `{ source: text, text }`"
 *               picks:
 *                 type: array
 *                 items: { type: object, properties: { registrationId: { type: string }, memberId: { type: string } } }
 *               summary: { type: string }
 *               dryRun: { type: boolean }
 *     responses:
 *       200: { description: "dryRun: `{ total, skipped, category, costInr, dailyLimit, preview, previewFor }`" }
 *       201: { description: "Started: the same, plus `id`" }
 *       400: { description: VALIDATION_ERROR, TEMPLATE_UNAVAILABLE, NO_RECIPIENTS, TOO_MANY_RECIPIENTS, MESSAGE_TOO_LONG }
 */
adminRouter.get("/broadcasts", adminBroadcastsController.list);
adminRouter.post("/broadcasts", adminBroadcastsController.create);

/**
 * @openapi
 * /admin/broadcasts/{id}:
 *   get:
 *     summary: One send, with `delivery` — counts by Meta's latest status
 *     tags: [Send messages]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The send }
 *       404: { description: NOT_FOUND }
 */
adminRouter.get("/broadcasts/:id", adminBroadcastsController.getOne);

/**
 * @openapi
 * /admin/broadcasts/{id}/recipients:
 *   get:
 *     summary: Who a send went to, in order, 100 a page, each with where it got to
 *     tags: [Send messages]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [pending, accepted, failed, delivered, read, undelivered] } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *     responses:
 *       200: { description: "`{ recipients, total, page, pageSize }`" }
 */
adminRouter.get("/broadcasts/:id/recipients", adminBroadcastsController.recipients);

/**
 * @openapi
 * /admin/broadcasts/{id}/stop:
 *   post:
 *     summary: Stop a send; messages already sent stay sent
 *     tags: [Send messages]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Stopped }
 * /admin/broadcasts/{id}/resume:
 *   post:
 *     summary: Carry on with a paused send
 *     tags: [Send messages]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Sending again }
 *       409: { description: NOT_PAUSED }
 */
adminRouter.post("/broadcasts/:id/stop", adminBroadcastsController.stop);
adminRouter.post("/broadcasts/:id/resume", adminBroadcastsController.resume);

/**
 * @openapi
 * /admin/assistant:
 *   get:
 *     summary: Whether the Assistant is set up, and whether it counts dummy data
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`{ configured, includeDummy }`"
 *   post:
 *     summary: One turn of an Assistant chat
 *     description: >
 *       Adds what is new (`messages`: a question, or the browser's tool
 *       results with their cards) to the stored chat `chatId`, sends the whole
 *       conversation to Claude, stores and returns the reply — an answer, or
 *       `tool_use` blocks for the browser to run. Shareable cards are also kept
 *       for "Recently asked by the team". See src/lib/assistant.ts.
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`{ content, stopReason }`"
 *       400:
 *         description: VALIDATION_ERROR
 *       404:
 *         description: CHAT_NOT_FOUND — not the caller's, deleted or expired
 *       409:
 *         description: CHAT_TOO_LONG — start a new chat
 *       502:
 *         description: AI_FAILED — the model call failed
 *       503:
 *         description: AI_NOT_CONFIGURED — ANTHROPIC_API_KEY is not set
 */
adminRouter.get("/assistant", assistantController.status);
adminRouter.post("/assistant", assistantController.turn);

/**
 * @openapi
 * /admin/assistant/chats:
 *   get:
 *     summary: The caller's Assistant chats, last used first (kept 30 days)
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`[{ id, title, questions, updatedAt }]`"
 *   post:
 *     summary: Start an empty chat
 *     tags: [Admin]
 *     responses:
 *       201:
 *         description: "`{ id }`"
 * /admin/assistant/chats/{id}:
 *   get:
 *     summary: One of the caller's chats, for redrawing it
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`{ id, title, updatedAt, messages }` — text, tool calls and cards; no thinking or result rows"
 *       404:
 *         description: CHAT_NOT_FOUND
 *   delete:
 *     summary: Delete one of the caller's chats
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: Deleted (or already gone)
 * /admin/assistant/team:
 *   get:
 *     summary: Recently asked by the team — shareable cards from the last 30 days
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`[{ id, question, title, card, askedByName, askedAt, timesAsked }]`"
 */
adminRouter.get("/assistant/chats", assistantController.listChats);
adminRouter.post("/assistant/chats", assistantController.createChat);
adminRouter.get("/assistant/chats/:id", assistantController.getChat);
adminRouter.delete("/assistant/chats/:id", assistantController.deleteChat);
adminRouter.get("/assistant/team", assistantController.team);
