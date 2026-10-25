import { defineWorkspace } from "vitest/config";

/**
 * Two projects: the packages (and bench) under the root config, and every example app under its
 * own config (the seed app's generated tests need its per-file database setup).
 */
export default defineWorkspace(["./vitest.config.ts", "./examples/*/vitest.config.ts"]);
