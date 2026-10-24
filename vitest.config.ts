import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts", "bench/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/averr/**"],
    testTimeout: 30_000,
  },
});
