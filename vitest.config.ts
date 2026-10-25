import { defineConfig } from "vitest/config";

export default defineConfig({
  // in-repo, workspace packages resolve to their TypeScript sources (the "development" export condition)
  resolve: { conditions: ["development"] },
  ssr: { resolve: { conditions: ["development"] } },
  test: {
    name: "packages",
    // examples/* run as their own workspace projects (vitest.workspace.ts)
    include: ["packages/*/test/**/*.test.ts", "bench/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/averri/**"],
    globalSetup: ["./vitest.global-setup.ts"],
    testTimeout: 30_000,
  },
});
