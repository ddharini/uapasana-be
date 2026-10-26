# Project Features

This template is designed to kickstart production-ready SaaS applications with a focus on security, developer experience, and scalability. It contains no product code — only the chassis every SaaS rebuilds.

## 🚀 Core Technology Stack
- **Modern Runtime**: Node.js with **Express 5.x** and **TypeScript**.
- **Database & ORM**: **Prisma** with **MongoDB** (Object data modeling made easy).
- **Package Manager**: **pnpm** for fast, disk-efficient dependency management.

## 🔐 Authentication — Better Auth
- **Full Auth Cycle**: Email/password signup, login, logout, and Google OAuth.
- **Session Cookies**: Session-based auth via Better Auth, no hand-rolled JWT handling.
- **Password Recovery**: "Forgot Password" and "Reset Password" flow, emailed via Resend.
- **Admin Role Gating**: A `role` field on `User` gates a separate admin surface — no self-serve path to admin by design.
- **Soft Account Deletion**: A 30-day grace period (`User.deletedAt`), with a restore endpoint and a standalone script (`scripts/hard-delete-scheduled-accounts.ts`) that purges anything past its grace period.

## 🛡 Admin Panel (minimal, generic)
- **Own Record**: `GET /admin/me` — confirms the signed-in session is both valid and actually admin.
- **User Management**: `GET /admin/users` (paginated, filterable by search/role/status) and `GET /admin/users/:id` (profile and a merged auth/account activity timeline).

## ⚙️ Background Jobs
- **MongoDB-Backed Queue**: no Redis to run. A `job` collection with atomic claiming via guarded `updateMany` — two workers can never run the same job.
- **Separate Worker Process**: `pnpm worker` / `worker:start`, deployed as its own service so slow work never makes a request-serving process slow.
- **Failure Handling That Survives**: exponential backoff, a per-job attempt ceiling, the last error preserved on the row, and `reapStuckJobs` to return work abandoned by a dead worker.
- **Graceful Shutdown**: SIGTERM stops new work and lets the in-flight job finish before exiting.
- **A Worked Example**: `src/lib/queue/handlers/example.ts` documents the four rules a handler must follow — typed payload, idempotence, throw-to-retry, never swallow.

## 🤖 AI — Anthropic (optional)
- **One Metered Client**: `src/lib/ai/claude.ts` is the only place the codebase calls Anthropic, so "every call is metered" and "every call has a timeout" are checkable by reading one file.
- **Timeouts Scaled To Output**: a fixed allowance plus a per-token budget, rather than the SDK's flat ten minutes — a hung call cannot outlive the job waiting on it.
- **JSON Repair**: `completeJson` handles the two failures models actually produce — a code fence, and prose either side of the object.
- **Degrades Cleanly**: no API key means the app still boots; only the calls that need it fail, with a message that says why.

## 💸 Usage Metering
- **Priced At The Call Site**: every billable third-party call writes a `usage_event` row at the moment it happens, priced from a table you keep in one place.
- **Attributable**: spend is tied to a user, so "what does this customer cost us" is a query rather than a spreadsheet.
- **Never Fails The Work**: a ledger write that throws is logged and swallowed — losing a completion the user already paid for is the worse outcome.

## 📝 API Documentation
- **Interactive Swagger UI**: Accessible at `/api-docs` to explore and test endpoints.
- **Annotation-driven generation**: Powered by `swagger-jsdoc` — specs are generated from OpenAPI annotations that live alongside the routes they document.

## 🛠 Developer Experience (DX)
- **Hierarchical Environments**: Support for `.env`, `.env.local`, and environment-specific overrides (Next.js style) using `dotenv-flow`.
- **Hot Reloading**: Automated server restarts during development with `nodemon`.
- **Clean Architecture**: Modular structure with a clear separation of controllers, routes, middlewares, and utilities.
- **Standardized Responses**: Centralized global error handling ensuring consistent API response structures.
- **Code Quality**: Pre-configured **Prettier** for consistent code formatting.
- **Test Suite**: Vitest, covering the plan table, the queue's concurrency guarantees, and the CAS lock helpers — 50 tests, no database required.
- **Honest Typecheck**: `pnpm typecheck` covers test files too, which the usual `extends`-inherited `exclude` silently skips.

## 🐳 Containerization
- **Production-Ready Docker**: Multi-stage `Dockerfile` optimized for minimal image size.
- **Orchestration**: `docker-compose.yml` for simplified local setup and deployment.
- **Build Optimization**: Includes `.dockerignore` to keep image builds fast and lean.

## 🛡 Security Best Practices
- **Session-Based Auth**: Better Auth manages sessions and cookies; no hand-rolled password/token storage.
- **CORS Protection**: Configurable Cross-Origin Resource Sharing.
- **Type Safety**: TypeScript-first approach reducing runtime errors.
