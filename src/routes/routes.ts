import express from "express";
import { healthController } from "../controllers/healthController";
import { authRouter } from "./authRoutes";
import { userRouter } from "./userRoutes";
import { adminRouter } from "./adminRoutes";
import { registrationRouter } from "./registrationRoutes";
import { inviteRouter } from "./inviteRoutes";
import { otpRouter } from "./otpRoutes";
import { scheduleRouter } from "./scheduleRoutes";
import { accommodationRouter } from "./accommodationRoutes";
import { guestRouter } from "./guestRoutes";
import { webhookRouter } from "./webhookRoutes";

export const router = express.Router();

const { getHealth } = healthController;

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Service health check (verifies database connectivity)
 *     tags: [General]
 *     responses:
 *       200:
 *         description: Service is healthy
 *       503:
 *         description: Service is degraded (database unreachable)
 */
router.get("/health", getHealth);
router.use("/auth", authRouter);
router.use("/users", userRouter);
router.use("/admin", adminRouter);
router.use("/registrations", registrationRouter);
router.use("/invites", inviteRouter);
router.use("/otp", otpRouter);
router.use("/schedule", scheduleRouter);
router.use("/accommodation", accommodationRouter);
router.use("/guests", guestRouter);
router.use("/webhooks", webhookRouter);
