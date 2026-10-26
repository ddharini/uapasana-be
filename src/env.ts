import dotenvFlow from "dotenv-flow";

/**
 * Loads .env before anything else in the process can read `process.env`.
 *
 * **Import this first, above every other import, in every entrypoint.** It is a
 * side-effect module on purpose: TypeScript emits `require()` calls in import
 * order, so `import "./env"` at the top of a file is the only thing that runs
 * before the rest of that file's import graph is evaluated.
 *
 * Most modules here dodge the ordering problem by reading `process.env` lazily,
 * at call time (see src/lib/email.ts).
 * `src/lib/auth.ts` cannot: `betterAuth()` takes its secret, base URL, trusted
 * origins and OAuth client credentials as plain values in a config object built
 * the moment the module is evaluated. Before this file existed, that evaluation
 * happened *before* `dotenvFlow.config()` ran in index.ts's body, so Better Auth
 * came up with an empty Google client id — and Google sign-in bounced off
 * Google's own error page with nothing in our logs to explain it.
 */
dotenvFlow.config();
