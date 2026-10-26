// Must stay the first import: it populates process.env before any module below
// it (notably ./lib/auth, via ./routes/routes) reads it. See src/env.ts.
import "./env";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { router } from "./routes/routes";
import { isAllowedOrigin } from "./lib/origins";
import { createServer } from "http";
import { prisma } from "./utils/db";
import { errorHandler } from "./middlewares/errorHandler";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./utils/swagger";
import { resumeBroadcasts } from "./lib/broadcasts";

const app = express();

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// The allow-list lives in ./lib/origins so that Better Auth's own origin check
// cannot disagree with this one. `origin` is a predicate rather than an array
// because in development it has to accept whichever port Vite settled on.
app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header at all: same-origin navigation, curl, a health probe.
      // These are not cross-origin requests, so there is nothing to deny.
      if (!origin) return callback(null, true);

      if (isAllowedOrigin(origin)) return callback(null, true);

      // Answer without the Allow-Origin header instead of throwing. Throwing
      // hands the request to the error handler, which returns a 500 that the
      // browser still reports as a CORS error — a misleading log line on the
      // server and no better a message in the console.
      console.warn(`⚠️  Blocked cross-origin request from ${origin}`);
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(cookieParser());

// Meta signs each WhatsApp webhook over the exact bytes it sent, so this route
// gets the raw body; parsed as JSON first, a re-serialised copy would never
// match the signature. Mounted before the general parser, which then leaves
// it alone.
app.use("/api/webhooks/whatsapp", express.raw({ type: "*/*", limit: "1mb" }));

// The Assistant sends its whole conversation, tool results included, with
// every turn: far past the default 100 kB. Parsed here first, so the general
// parser below leaves it alone.
app.use("/api/admin/assistant", express.json({ limit: "2mb" }));
app.use(express.json());

app.use("/api", router);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use(errorHandler as unknown as express.ErrorRequestHandler);

const server = createServer(app);

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await prisma.$connect();
    console.log("✅ Successfully connected to the database");

    server.listen(PORT, () => {
      console.log(`✅ HTTP server running on http://localhost:${PORT}`);
      // Sends from Send messages that a restart interrupted.
      resumeBroadcasts().catch(error =>
        console.error("[Broadcast] Could not resume sends:", error)
      );
    });

    const shutdown = async () => {
      console.log("🛑 Shutting down server...");
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Failed to connect to the database:", error);
    process.exit(1);
  }
}
startServer();
