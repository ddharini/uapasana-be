import express from "express";

import { accommodationController } from "../controllers/accommodationController";
import { protect, requireAdmin, requireReviewer, requireStaff } from "../middlewares/authMiddleware";

export const accommodationRouter = express.Router();

const {
  overview,
  createPlace,
  updatePlace,
  deletePlace,
  createMandalStay,
  updateMandalStay,
  deleteMandalStay,
  updateOccupancy,
} = accommodationController;
// PAUSED 2026-10-11 — per-person allotment; its routes are commented out below.
// const { allotmentOverview, allot, release, sendNotice, sendAllNotices } = accommodationController;

/**
 * @openapi
 * tags:
 *   name: Accommodation
 *   description: >
 *     Places and rooms, and which rooms each mandal was given. Desk roles
 *     read; staff and admins give rooms to mandals; the mandal's sanchalak,
 *     staff and admins report occupancy; admins edit places.
 */

// The desk only, and a sanchalak only for their mandal.
accommodationRouter.use(protect, requireStaff);

/**
 * @openapi
 * /accommodation:
 *   get:
 *     summary: Places and the rooms given to mandals
 *     description: >
 *       Every place with its rooms, and every mandal's rooms the viewer may
 *       see (only their own mandal's for a sanchalak), with occupancy.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: "`{ places, mandalStays }`"
 */
accommodationRouter.get("/", overview);

/**
 * @openapi
 * /accommodation/mandal-stays:
 *   post:
 *     summary: Give a mandal rooms at a place
 *     description: >
 *       `{ placeId, mandal, coordinatorName, coordinatorMobile, notes?, roomIds }`.
 *       One entry per mandal per place; a room belongs to one mandal at most.
 *     tags: [Accommodation]
 *     responses:
 *       201:
 *         description: The mandal's rooms
 *       409:
 *         description: ROOM_TAKEN, MANDAL_TAKEN or ROOM_GONE
 */
accommodationRouter.post("/mandal-stays", requireReviewer, createMandalStay);

/**
 * @openapi
 * /accommodation/mandal-stays/{id}:
 *   patch:
 *     summary: Change a mandal's rooms or coordinator
 *     description: Same body as POST. Occupancy of rooms taken back is dropped.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: The mandal's rooms
 *       409:
 *         description: ROOM_TAKEN, MANDAL_TAKEN or ROOM_GONE
 *   delete:
 *     summary: Take back all of a mandal's rooms at a place
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: Taken back
 */
accommodationRouter.patch("/mandal-stays/:id", requireReviewer, updateMandalStay);
accommodationRouter.delete("/mandal-stays/:id", requireReviewer, deleteMandalStay);

/**
 * @openapi
 * /accommodation/mandal-stays/{id}/occupancy:
 *   put:
 *     summary: Report how many people are in each of a mandal's rooms
 *     description: >
 *       `{ rooms: [{ roomId, people }] }`. Staff and admins for any mandal, a
 *       sanchalak for their own. Rooms left out keep what they had.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: The mandal's rooms
 */
accommodationRouter.put("/mandal-stays/:id/occupancy", updateOccupancy);

// ---------------------------------------------------------------------------
// PAUSED 2026-10-11 — per-person allotment and room-detail notices. Rooms now
// go to mandals (above). Uncomment these, and the destructuring at the top,
// to bring it back; the frontend screens are in
// upasana-fe/src/features/accommodation/paused/.
// ---------------------------------------------------------------------------

// accommodationRouter.get("/allotments", allotmentOverview);

/**
 * (paused; not in the API docs)
 * /accommodation/allotments:
 *   post:
 *     summary: Put people in a room
 *     description: >
 *       `{ registrationId, assignments: [{ memberId, placeId, roomId }] }` —
 *       a room per person, saved together or not at all — or the shorter
 *       `{ registrationId, memberIds, placeId, roomId }` for one room. Moves
 *       anyone who already had a room. The registration must be confirmed and
 *       have asked for accommodation; every room must fit its people on every
 *       night.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: The registration's allotments
 *       409:
 *         description: NOT_CONFIRMED, NO_STAY_REQUESTED, NO_NIGHTS or ROOM_PROBLEM
 */
// accommodationRouter.post("/allotments", requireReviewer, allot);

/**
 * (paused; not in the API docs)
 * /accommodation/allotments/release:
 *   post:
 *     summary: Take people out of their rooms
 *     description: "`{ registrationId, memberIds }`"
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: The registration's remaining allotments
 */
// accommodationRouter.post("/allotments/release", requireReviewer, release);

/**
 * (paused; not in the API docs)
 * /accommodation/registrations/{id}/notice:
 *   post:
 *     summary: Send a registration its room details on WhatsApp
 *     description: >
 *       Without WhatsApp on the server, answers `{ sent: false, message,
 *       whatsappUrl }` to send by hand; `{ manual: true }` then records it as sent.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: "`{ sent, channel }`, or the message to send by hand"
 *       409:
 *         description: NOT_CONFIRMED, NOTHING_ALLOTTED or NO_CONTACT
 *       502:
 *         description: SEND_FAILED
 */
// accommodationRouter.post("/registrations/:id/notice", requireReviewer, sendNotice);

/**
 * (paused; not in the API docs)
 * /accommodation/notices/send-all:
 *   post:
 *     summary: Send room details to everyone fully allotted and not yet told
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: "`{ sent, failed, incomplete }`"
 *       503:
 *         description: WHATSAPP_NOT_CONFIGURED
 */
// accommodationRouter.post("/notices/send-all", requireReviewer, sendAllNotices);

/**
 * @openapi
 * /accommodation/places:
 *   post:
 *     summary: Add a place (admin)
 *     tags: [Accommodation]
 *     responses:
 *       201:
 *         description: The place
 *       409:
 *         description: NAME_TAKEN
 */
accommodationRouter.post("/places", requireAdmin, createPlace);

/**
 * @openapi
 * /accommodation/places/{id}:
 *   patch:
 *     summary: Change a place and its rooms (admin)
 *     description: Rooms given to a mandal cannot be removed until they are taken back.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: The place
 *       409:
 *         description: ROOM_IN_USE or NAME_TAKEN
 *   delete:
 *     summary: Remove a place no mandal has rooms at (admin)
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: Removed
 *       409:
 *         description: PLACE_IN_USE
 */
accommodationRouter.patch("/places/:id", requireAdmin, updatePlace);
accommodationRouter.delete("/places/:id", requireAdmin, deletePlace);
