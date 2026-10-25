/**
 * A6001 — Generated test is stale: a generated Test's `sourceHash` differs from the `hash:` of the
 * `@generated` header of its file on disk, or the file is missing. Fix: the regeneration command only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isGeneratedTestStale } from "@averri/testgen";
import type { Diagnostic, TestNode } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

/** File content or null, memoised per build. */
export function generatedFileReader(root: string): (file: string) => string | null {
  const cache = new Map<string, string | null>();
  return (file) => {
    if (cache.has(file)) return cache.get(file) ?? null;
    const abs = path.join(root, file);
    const t = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    cache.set(file, t);
    return t;
  };
}

export function isStale(read: (file: string) => string | null, t: TestNode): boolean {
  return isGeneratedTestStale(t, read(t.file));
}

export function ruleA6001(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const read = generatedFileReader(ctx.state.root);
  const tests = [...ctx.state.nodes.values()].filter((n): n is TestNode => n.kind === "Test" && (n as TestNode).generated).sort((a, b) => compareStrings(a.id, b.id));
  for (const t of tests) {
    if (!isStale(read, t)) continue;
    const missing = read(t.file) === null;
    out.push(
      emit("A6001", {
        node: t.id,
        src: { file: t.file, range: [[1, 0], [1, 0]] },
        title: `Generated test is stale: ${t.id.slice("Test:".length)}`,
        message: missing ? `${t.file} does not exist.` : `${t.file} was generated from a different declaration (hash mismatch).`,
        cause: [{ node: t.id, why: missing ? "generated file missing" : "sourceHash differs from the @generated header" }],
        related: t.covers.slice(0, 5),
        fixes: [{ label: "Regenerate", evidence: missing ? "the generated file is missing" : "the declaration changed since the file was generated", command: `averri testgen --only ${t.id}` }],
      }),
    );
  }
  return out;
}
