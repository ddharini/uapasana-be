import express from "express";

import { guestController } from "../controllers/guestController";
import {
  optionalSession,
  protect,
  requireReviewer,
  requireStaff,
} from "../middlewares/authMiddleware";

export const guestRouter = express.Router();

const { create, list, getOne, update, remove } = guestController;

/**
 * @openapi
 * tags:
 *   name: Guests
 *   description: Walk-in guests — a host's friends or family coming for the day and its meals
 */

/**
 * @openapi
 * /guests:
 *   post:
 *     summary: Send in a host's walk-in guests
 *     description: >
 *       Public: hosts use the shared /guests/register link without an account.
 *       `{ hostName, hostMobile, hostMandal, guestNames?, days: [{ date, guests, meals }], notes? }`.
 *       A request with a desk session is recorded as `source: "staff"`. The
 *       public link takes at most 20 entries per host number.
 *     tags: [Guests]
 *     responses:
 *       201:
 *         description: The stored entry
 *       400:
 *         description: VALIDATION_ERROR, with every field problem in `errors`
 *       403:
 *         description: WRONG_MANDAL — a sanchalak adding another mandal's guests
 *       429:
 *         description: TOO_MANY_ENTRIES
 */
guestRouter.post("/", optionalSession, create);

// Everything below is the desk: a sanchalak only for their mandal.
guestRouter.use(protect, requireStaff);

/**
 * @openapi
 * /guests:
 *   get:
 *     summary: Every guest entry, newest first
 *     tags: [Guests]
 *     responses:
 *       200:
 *         description: All entries the viewer may see
 */
guestRouter.get("/", list);

/**
 * @openapi
 * /guests/{id}:
 *   get:
 *     summary: One guest entry
 *     tags: [Guests]
 *     responses:
 *       200:
 *         description: The entry
 *       404:
 *         description: NOT_FOUND
 *   patch:
 *     summary: Correct a guest entry
 *     tags: [Guests]
 *     responses:
 *       200:
 *         description: The updated entry
 *       404:
 *         description: NOT_FOUND
 *   delete:
 *     summary: Remove a guest entry (staff and admins)
 *     tags: [Guests]
 *     responses:
 *       200:
 *         description: "`{ id }`"
 *       404:
 *         description: NOT_FOUND
 */
guestRouter.get("/:id", getOne);
guestRouter.patch("/:id", update);
guestRouter.delete("/:id", requireReviewer, remove);
