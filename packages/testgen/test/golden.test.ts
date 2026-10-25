/**
 * Golden files: the exact text generated for the reference graph. Regenerate with
 *   UPDATE_GOLDEN=1 npx vitest run packages/testgen/test/golden.test.ts
 * and review the diff like any other code change.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateTests } from "../src/generate.js";
import { referenceGraph } from "./fixture-graph.js";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

describe("golden files", () => {
  const files = generateTests(referenceGraph(), { actors: ["anonymous", "member", "admin"] });

  it("every generated file matches its golden copy", () => {
    mkdirSync(goldenDir, { recursive: true });
    for (const f of files) {
      const goldenPath = join(goldenDir, `${f.path.split("/").pop()}.txt`);
      if (UPDATE || !existsSync(goldenPath)) writeFileSync(goldenPath, f.content, { encoding: "utf8" });
      const golden = readFileSync(goldenPath, "utf8");
      expect(f.content, `golden mismatch for ${f.path} (run with UPDATE_GOLDEN=1 to accept)`).toBe(golden);
    }
  });

  it("no stale golden files remain", () => {
    const expected = new Set(files.map((f) => `${f.path.split("/").pop()}.txt`));
    const present = readdirSync(goldenDir).filter((n) => n.endsWith(".txt"));
    expect(present.sort()).toEqual([...expected].sort());
  });
});
