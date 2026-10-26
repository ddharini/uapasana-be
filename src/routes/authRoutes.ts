import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "../lib/auth";

export const authRouter = express.Router();

authRouter.use(toNodeHandler(auth.handler));
