import { Request, Response } from "express";

/**
 * Everything here runs behind `protect` + `requireAdmin` (see adminRoutes.ts),
 * so `req.user` is always an authenticated admin.
 */

const getMe = (req: Request, res: Response): void => {
  const { id, name, email, role } = req.user;
  res.status(200).json({ success: true, data: { user: { id, name, email, role } } });
};

export const adminController = {
  getMe,
};
