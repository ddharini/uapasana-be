import { Request, Response } from "express";

import {
  SAMPLE_COUNT,
  countSampleRegistrations,
  insertSampleRegistrations,
  removeSampleRegistrations,
} from "../lib/sample-registrations";

/**
 * The "Show dummy data" / "Remove dummy data" toggle on the Registrations
 * screen. Admin only (adminRoutes). Only ever touches registrations flagged
 * `isSample` — real ones are never added, changed or removed here.
 */

const status = async (_req: Request, res: Response): Promise<void> => {
  res
    .status(200)
    .json({
      success: true,
      data: { count: await countSampleRegistrations(), total: SAMPLE_COUNT },
    });
};

const add = async (_req: Request, res: Response): Promise<void> => {
  const { added, clash } = await insertSampleRegistrations();
  if (clash) {
    res.status(409).json({
      success: false,
      code: "SAMPLE_CODES_TAKEN",
      message: `${clash} is a real registration, so the dummy data cannot use its codes.`,
    });
    return;
  }
  res.status(201).json({ success: true, data: { added, count: await countSampleRegistrations() } });
};

const remove = async (_req: Request, res: Response): Promise<void> => {
  const removed = await removeSampleRegistrations();
  res.status(200).json({ success: true, data: { removed, count: 0 } });
};

export const adminSampleDataController = { status, add, remove };
