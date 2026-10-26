import { Request, Response } from "express";
import { prisma } from "../utils/db";

const getHealth = async (req: Request, res: Response) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.status(200).json({
      success: true,
      data: { status: "ok", database: "connected", uptime: process.uptime() },
    });
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(503).json({
      success: false,
      error: "Service Unavailable",
      data: { status: "degraded", database: "disconnected" },
    });
  }
};

export const healthController = {
  getHealth,
};
