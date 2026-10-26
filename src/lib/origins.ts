/**
 * The one place that decides which browser origins this API talks to.
 *
 * Two separate gates have to agree on this, and when they drifted apart the
 * symptom was a CORS error that looked like a server bug:
 *
 *   1. the `cors` middleware in src/index.ts, which answers the preflight, and
 *   2. Better Auth's own origin check, which rejects a `POST /api/auth/*`
 *      whose `Origin`, `callbackURL` or `redirectTo` it does not trust.
 *
 * Passing (1) and failing (2) produces a `403` with no CORS headers on it, so
 * the browser reports it as a CORS failure rather than as the origin rejection
 * it actually is. Both now read the same list from here.
 *
 * In development the list is deliberately loose: Vite takes the next free port
 * when 5173 is busy, so a second `pnpm dev` (or a dev server left running in
 * another terminal) silently moves the frontend to 5174 and every request
 * starts failing. Any loopback port is accepted instead — nothing outside the
 * developer's own machine can reach it. In production only the configured URLs
 * are trusted, and `credentials: true` makes that strictness the point: a
 * reflected origin there would hand any site the user's session cookie.
 */

const isProduction = process.env.NODE_ENV === "production";

/** Explicitly configured frontends. These are trusted in every environment. */
const configuredOrigins = [
  process.env.FRONTEND_URL || "http://localhost:5173",
  process.env.ADMIN_URL || "http://localhost:5180",
].filter((origin): origin is string => Boolean(origin));

/** `http://localhost:5174`, `http://127.0.0.1:3000`, `http://[::1]:5173`, … */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * `http://192.168.1.20:5173` and the other private-network ranges: the
 * address a phone on the same Wi-Fi uses to reach `vite --host` on this
 * machine. The registration form is used mostly on phones, so it has to be
 * testable on one. Development only, like the loopback rule.
 */
const PRIVATE_NETWORK_ORIGIN =
  /^https?:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

/**
 * Trusted origins in the form Better Auth wants them.
 *
 * It matches these as glob patterns when they contain `*`, so `http://localhost:*`
 * covers whichever port Vite ended up on. The loopback regex below is the same
 * rule spelled out for `cors`, which takes a predicate rather than a pattern.
 */
export const trustedOrigins = isProduction
  ? configuredOrigins
  : [
      ...configuredOrigins,
      "http://localhost:*",
      "http://127.0.0.1:*",
      "http://[::1]:*",
      // Wider than PRIVATE_NETWORK_ORIGIN (172.* rather than 172.16–31), since
      // a glob cannot express the range. Still development only.
      "http://192.168.*:*",
      "http://10.*:*",
      "http://172.*:*",
    ];

/** Whether a browser `Origin` header may make credentialed requests to this API. */
export function isAllowedOrigin(origin: string): boolean {
  if (configuredOrigins.includes(origin)) return true;
  return !isProduction && (LOOPBACK_ORIGIN.test(origin) || PRIVATE_NETWORK_ORIGIN.test(origin));
}
