import { Request, Response, NextFunction } from "express";
import { auth } from "../lib/auth";

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const protect = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers as any,
    });

    if (!session) {
      res.status(401).json({ success: false, message: "Not authorized to access this route" });
      return;
    }

    // Attach user information to the request
    req.user = session.user;
    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    res.status(401).json({ success: false, message: "Not authorized to access this route" });
  }
};

/**
 * Gates the admin routes. Must run after `protect` — it reads `req.user`,
 * which only `protect` sets. `role` is a plain string field with no self-serve
 * write path (see the comment on `User.role` in schema.prisma), so this check
 * is trustworthy: only `pnpm grant-role` or an invite sent by an existing
 * admin can make an account "admin".
 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ success: false, code: "NOT_ADMIN", message: "Admin access required" });
    return;
  }
  next();
};

/**
 * Roles that use the registration desk. A sanchalak only for their own
 * mandal — see `registrationScope`.
 */
export const DESK_ROLES = new Set(["staff", "admin", "sanchalak"]);

/** Roles that review registrations: confirm, check in, cancel. */
export const REVIEW_ROLES = new Set(["staff", "admin"]);

/** Roles that may vouch for a contact's mobile in person instead of an OTP. */
export const IN_PERSON_ROLES = new Set(["sanchalak", "admin"]);

/**
 * The registrations a signed-in desk user may see and change, as a Prisma
 * filter: everything for staff and admins, one mandal for a sanchalak. A
 * sanchalak with no mandal set sees nothing rather than everything.
 */
export function registrationScope(user: { role?: string; mandal?: string | null } | undefined) {
  if (user?.role !== "sanchalak") return {};
  return { mandal: user.mandal ?? "\u0000no-mandal" };
}

/**
 * Gates the registration desk. Must run after `protect`.
 *
 * Registrations hold devotees' names, ages and mobile numbers, so being signed
 * in is not enough: anyone can create an account from the login screen. A new
 * account is "user" and is refused here until it is given a role — by an
 * admin's invite, or `pnpm grant-role`.
 */
export const requireStaff = (req: Request, res: Response, next: NextFunction): void => {
  if (!DESK_ROLES.has(req.user?.role)) {
    res.status(403).json({
      success: false,
      code: "NOT_STAFF",
      message: "Your account does not have access to registrations yet.",
    });
    return;
  }
  next();
};

/** Gates reviewing (status changes). Must run after `protect`. */
export const requireReviewer = (req: Request, res: Response, next: NextFunction): void => {
  if (!REVIEW_ROLES.has(req.user?.role)) {
    res.status(403).json({
      success: false,
      code: "NOT_REVIEWER",
      message: "Only the seva team can confirm, check in or cancel registrations.",
    });
    return;
  }
  next();
};

/**
 * Attaches `req.user` when a session exists, and carries on either way.
 *
 * For the public registration endpoint, which a devotee uses signed out and
 * staff use signed in: who submitted it decides the registration's `source`.
 */
export const optionalSession = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await auth.api.getSession({ headers: req.headers as any });
    if (session) req.user = session.user;
  } catch {
    // An unreadable session is treated as no session; the route is public.
  }
  next();
};
