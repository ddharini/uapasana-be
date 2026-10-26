import express from "express";

import { scheduleController } from "../controllers/scheduleController";
import { protect, requireAdmin } from "../middlewares/authMiddleware";

export const scheduleRouter = express.Router();

const {
  list,
  publish,
  published,
  createDay,
  updateDay,
  deleteDay,
  createSession,
  updateSession,
  deleteSession,
} = scheduleController;

/**
 * @openapi
 * tags:
 *   name: Schedule
 *   description: >
 *     The event programme. Admins edit a draft and publish it; devotees read
 *     the published copy without signing in.
 */

/**
 * @openapi
 * /schedule/published:
 *   get:
 *     summary: The published programme, for devotees
 *     description: Public. Never the draft. Empty `days` until the first publish.
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: "`{ days, publishedAt }`"
 */
scheduleRouter.get("/published", published);

// Everything below is the draft: admins only.
scheduleRouter.use(protect, requireAdmin);

/**
 * @openapi
 * /schedule:
 *   get:
 *     summary: The draft programme and its publish status
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: "`{ days, publication, unpublishedChanges }`"
 */
scheduleRouter.get("/", list);

/**
 * @openapi
 * /schedule/publish:
 *   post:
 *     summary: Publish the draft to devotees
 *     tags: [Schedule]
 *     responses:
 *       201:
 *         description: The draft state, now with no unpublished changes
 */
scheduleRouter.post("/publish", publish);

/**
 * @openapi
 * /schedule/days:
 *   post:
 *     summary: Add a day — `{ date, theme? }`
 *     tags: [Schedule]
 *     responses:
 *       201:
 *         description: The new day
 *       409:
 *         description: DATE_TAKEN
 */
scheduleRouter.post("/days", createDay);

/**
 * @openapi
 * /schedule/days/{id}:
 *   patch:
 *     summary: Change a day's date or theme
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: The updated day
 *       409:
 *         description: DATE_TAKEN
 *   delete:
 *     summary: Remove a day and all its sessions
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: Removed
 */
scheduleRouter.patch("/days/:id", updateDay);
scheduleRouter.delete("/days/:id", deleteDay);

/**
 * @openapi
 * /schedule/days/{id}/sessions:
 *   post:
 *     summary: Add a session — `{ start, end, title, kind, place, note? }`
 *     tags: [Schedule]
 *     responses:
 *       201:
 *         description: The day, with the new session in place
 */
scheduleRouter.post("/days/:id/sessions", createSession);

/**
 * @openapi
 * /schedule/days/{id}/sessions/{sessionId}:
 *   patch:
 *     summary: Edit a session
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: The day, with the session updated
 *   delete:
 *     summary: Remove a session
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: The day, without the session
 */
scheduleRouter.patch("/days/:id/sessions/:sessionId", updateSession);
scheduleRouter.delete("/days/:id/sessions/:sessionId", deleteSession);
