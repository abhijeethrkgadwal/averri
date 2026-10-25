import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Fixture projects under packages/*\/test/fixtures are analysed by ts-morph with default compiler options,
 * so `@averri/core` and `zod` resolve like they do in a user's project: through the package's `types`
 * condition (dist/*.d.ts), not the in-repo `development` source condition. Keep dist current (incremental,
 * a no-op when nothing changed) so `npx vitest run` works from a clean checkout without `npm run build`.
 */
export default function setup(): void {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-b", "tsconfig.build.json"], { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "inherit" });
}
