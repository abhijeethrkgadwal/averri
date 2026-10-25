import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "packages",
    // examples/* run as their own workspace projects (vitest.workspace.ts)
    include: ["packages/*/test/**/*.test.ts", "bench/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/averri/**"],
    testTimeout: 30_000,
  },
});
