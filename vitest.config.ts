import { defineConfig } from "vitest/config";

/**
 * Unit tests only — no database, no network.
 *
 * Every module under test here is a pure function of its arguments, or is made
 * one by mocking `src/utils/db`. That is deliberate: the parts of a codebase
 * worth a unit test are the ones that decide a number (a quota, a price, a
 * retry delay) where being wrong is silent. Integration coverage that needs a
 * real Mongo belongs in its own suite with its own setup, not here.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: { NODE_ENV: "test" },
  },
});
