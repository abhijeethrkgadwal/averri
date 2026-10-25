import { defineProject } from "vitest/config";

/**
 * Seed-app test project: hand-written tests (`test/`) plus Averri's generated tests (`tests/averri/`,
 * written by `averri build` / `averri testgen`). `test/setup-averri.ts` gives each file its own seeded
 * SQLite database before the entry module is imported.
 */
export default defineProject({
  test: {
    name: "seed-app",
    include: ["test/**/*.test.ts", "tests/averri/**/*.gen.test.ts"],
    setupFiles: ["./test/setup-averri.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
