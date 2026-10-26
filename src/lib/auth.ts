import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "../utils/db";
import { sendEmail } from "./email";
import { resetPasswordEmail, welcomeEmail } from "./email-templates";
import { trustedOrigins } from "./origins";

/**
 * This server's own origin, and the path Better Auth is mounted under.
 *
 * Read at module scope, which is safe only because every entrypoint imports
 * `src/env.ts` first — see the comment there. Kept as one constant because the
 * Google redirect URI below has to match this exactly, character for character,
 * and a hand-written second copy is exactly the kind of thing that drifts.
 */
const serverURL = process.env.BETTER_AUTH_URL || "http://localhost:5000";
const authBaseURL = `${serverURL}/api/auth`;

/**
 * Google OAuth, registered only when both halves of the credential are actually
 * present.
 *
 * Better Auth does not validate these. Handed an empty client id it still
 * accepts `POST /sign-in/social` and still redirects the browser to Google,
 * which then shows the user a Google-branded "invalid client" page — no request
 * ever comes back to us, so nothing appears in our logs. Omitting the provider
 * instead turns that into a clean `400` from our own API, and the warning below
 * says what to set.
 *
 * `replace-me` is .env.example's placeholder, and a copied-but-unedited .env is
 * by far the most common way to end up here.
 */
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleConfigured =
  !!googleClientId &&
  !!googleClientSecret &&
  googleClientId !== "replace-me" &&
  googleClientSecret !== "replace-me";

if (!googleConfigured) {
  console.warn(
    "⚠️  Google sign-in is disabled: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env. " +
      `Authorised redirect URI in Google Cloud Console: ${authBaseURL}/callback/google`
  );
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "mongodb",
  }),
  baseURL: authBaseURL,
  // Shared with the CORS middleware in src/index.ts — see ./origins for why
  // these two have to be the same list. Better Auth checks the Origin header
  // *and* the callbackURL/redirectTo the client sends, so an origin missing
  // here fails sign-in even once the preflight succeeds.
  trustedOrigins,
  advanced: {
    database: {
      generateId: () => {
        const crypto = require("crypto");
        return crypto.randomBytes(12).toString("hex");
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    // `url` already carries the verification token and points at
    // `${FRONTEND_URL}/reset-password` (redirectTo, set by the client's own
    // `requestPasswordReset` call) — nothing here builds a URL by hand.
    sendResetPassword: async ({ user, url }) => {
      const { subject, html } = resetPasswordEmail({ url });
      await sendEmail({ to: user.email, subject, html });
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Fires for both credential and Google-OAuth signup — a real `user` row
        // exists either way. Caught here rather than left to propagate: signup
        // must succeed even if Resend is down or unconfigured, so a failed
        // welcome email is a logged miss, never a blocked account.
        after: async (user) => {
          try {
            const { subject, html } = welcomeEmail({ name: user.name });
            await sendEmail({ to: user.email, subject, html });
          } catch (error) {
            console.error(`[Email] Welcome email failed for ${user.email}:`, error);
          }
        },
      },
    },
  },
  user: {
    // Surfaced on `session.user`, which `protect` assigns to `req.user`, and on
    // the sign-in / sign-up payloads the frontend already reads — so the
    // onboarding guard can decide from the session it already has, with no extra
    // round trip on every navigation.
    //
    // **`input: false` on all of these.** Better Auth would otherwise accept
    // them in the sign-up body, letting a client stamp its own `onboardedAt` (and
    // walk straight past onboarding) or its own `role` (and grant itself admin).
    // `onboardedAt` is written only by POST /api/users/onboarding; `role` only
    // by `pnpm grant-role` and by accepting an admin's invite
    // (POST /api/invites/:token/accept) — there is no self-serve admin signup
    // by design.
    additionalFields: {
      onboardedAt: { type: "date", required: false, input: false },
      role: { type: "string", required: false, input: false, defaultValue: "user" },
      // A sanchalak's mandal, so the desk can scope itself from the session.
      mandal: { type: "string", required: false, input: false },
      // See the field's own comment in schema.prisma. Surfaced on the session
      // exactly like `onboardedAt`, so `RequireActiveAccount` can decide from
      // the session it already has rather than a second round trip.
      deletedAt: { type: "date", required: false, input: false },
    },
    // Better Auth's own delete-user flow is disabled on purpose: it does a real
    // `prisma.user.delete()`, which this schema cascades — every session and
    // account row, gone in one call, with no way to stop the cascade
    // partway through and turn it into a soft delete instead.
    //
    // Account deletion is `POST /users/delete` (userController.ts) now, which
    // reimplements the same two-factor verification this used to provide —
    // password for a credential account, a fresh session (`session.freshAge`,
    // 1 day) for an OAuth-only one — using Better Auth's own `verifyPassword`
    // and `auth.api.getSession`, and sets `deletedAt` instead of calling into
    // this at all. `POST /users/restore` clears it within the 30-day window;
    // `scripts/hard-delete-scheduled-accounts.ts` is the only code path left
    // that still does a real, cascading delete.
  },
  socialProviders: googleConfigured
    ? {
        google: {
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          // Stated rather than inferred. Better Auth would derive the same value
          // from `baseURL`, but Google rejects the whole flow on any mismatch
          // with the console's "Authorised redirect URI", so it is worth having
          // the exact string in the source you would read while debugging that.
          redirectURI: `${authBaseURL}/callback/google`,
          // Without this Google silently reuses whichever account the browser is
          // already signed into, which makes "sign in as someone else" look
          // broken on any machine with more than one Google account.
          prompt: "select_account",
        },
      }
    : {},
});
