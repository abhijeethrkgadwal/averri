/**
 * The emitted tests must typecheck in a strict project that has `vitest`, `fast-check` and
 * `@averri/contracts`. `@averri/contracts` is mapped onto `src/harness-api.ts` (the surface the
 * generated code is written against); vitest and fast-check resolve from the monorepo's node_modules
 * because the fixture project lives under `packages/testgen/.tmp-typecheck/` (gitignored, outside the
 * root tsconfig's include globs).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { generateTests } from "../src/generate.js";
import { referenceGraph } from "./fixture-graph.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const tmp = join(pkgRoot, ".tmp-typecheck", `p${process.pid}-${Date.now().toString(36)}`);
const require = createRequire(import.meta.url);

function write(rel: string, content: string): void {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, { encoding: "utf8" });
}

afterAll(() => {
  if (process.env["KEEP_TMP"] !== "1") rmSync(tmp, { recursive: true, force: true });
});

describe("emitted tests typecheck in a strict consumer project", () => {
  it("tsc --noEmit passes with noUnusedLocals/noUnusedParameters", { timeout: 180_000 }, () => {
    const files = generateTests(referenceGraph(), { actors: ["anonymous", "member", "admin"] });
    expect(files.length).toBeGreaterThan(0);
    const stubbed = new Set<string>();
    for (const f of files) {
      write(f.path, f.content);
      for (const m of f.content.matchAll(/from "(\.\.\/\.\.\/[^"]+)\.js";/g)) {
        const rel = `${m[1]!.replace(/^(\.\.\/)+/, "")}.ts`;
        if (stubbed.has(rel)) continue;
        stubbed.add(rel);
        if (rel === "averri.config.ts") write(rel, 'export default { actors: { anonymous: { actor: null } }, test: { generatedDir: "tests/averri" } } as const;\n');
        else if (rel === "src/app.ts") write(rel, "export default { fetch: async (_req: Request): Promise<Response> => new Response(\"ok\") };\n");
        else write(rel, `export const declaration = { kind: "stub", from: ${JSON.stringify(rel)} } as const;\n`);
      }
    }
    write("package.json", JSON.stringify({ name: "fixture-project", private: true, type: "module" }, null, 2));
    write(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022"],
            types: ["node"],
            strict: true,
            noUncheckedIndexedAccess: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noImplicitOverride: true,
            exactOptionalPropertyTypes: true,
            skipLibCheck: true,
            noEmit: true,
            baseUrl: ".",
            paths: { "@averri/contracts": [join(pkgRoot, "src", "harness-api.ts").replace(/\\/g, "/")] },
          },
          include: ["tests/**/*.ts", "src/**/*.ts", "averri.config.ts"],
        },
        null,
        2,
      ),
    );
    const tsc = require.resolve("typescript/lib/tsc.js");
    let output = "";
    try {
      output = execFileSync(process.execPath, [tsc, "-p", join(tmp, "tsconfig.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      expect.fail(`tsc reported errors for the generated tests:\n${output}`);
    }
    expect(output.trim()).toBe("");
  });
});
