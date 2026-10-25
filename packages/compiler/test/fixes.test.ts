/**
 * Fix-applies cases (SPEC-DIAGNOSTICS §6): apply every patch fix of the team-app build to a copy of the
 * project, rebuild, and check that the diagnostics those fixes target are gone.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Diagnostic, Graph } from "@averri/ir";
import { build } from "../src/build.js";
import { applyFilePatch, parseUnifiedDiff } from "../src/patch.js";
import { BUILD_TIMEOUT, copyFixture, type FixtureCopy } from "./helpers.js";

const copies: FixtureCopy[] = [];
let before: Graph;
/** Each round: the fixes applied on a fresh copy and the graph rebuilt from it. */
const rounds: Array<{ applied: Diagnostic[]; after: Graph }> = [];
let applied: Diagnostic[] = [];
let after: Graph;

/** Apply patches bottom-up per file so earlier hunks keep their line numbers. */
function applyAll(root: string, diags: Diagnostic[]): Diagnostic[] {
  const withPatch = diags.filter((d) => d.fixes[0]?.patch);
  const entries = withPatch.map((d) => {
    const files = parseUnifiedDiff(d.fixes[0]?.patch as string);
    const maxLine = Math.max(...files.flatMap((f) => f.hunks.map((h) => h.oldStart)));
    return { d, files, maxLine };
  });
  entries.sort((a, b) => b.maxLine - a.maxLine);
  const done: Diagnostic[] = [];
  for (const e of entries) {
    let ok = true;
    const next = new Map<string, string>();
    for (const f of e.files) {
      const file = path.join(root, f.oldFile as string);
      const text = next.get(file) ?? fs.readFileSync(file, "utf8");
      const out = applyFilePatch(text, f);
      if (out === null) ok = false;
      else next.set(file, out);
    }
    if (!ok) continue;
    for (const [file, text] of next) fs.writeFileSync(file, text);
    done.push(e.d);
  }
  return done;
}

beforeAll(() => {
  const first = copyFixture("team-app");
  copies.push(first);
  before = build(first.root, { writeCache: false, git: false }).graph;
  // Every patch applies to the ORIGINAL tree; patches whose context overlaps another fix's lines go to
  // the next round, applied to a fresh copy.
  let pending = before.diagnostics.filter((d) => d.fixes[0]?.patch);
  let root = first.root;
  while (pending.length > 0 && rounds.length < 5) {
    const done = applyAll(root, pending);
    if (done.length === 0) break;
    rounds.push({ applied: done, after: build(root, { writeCache: false, git: false }).graph });
    pending = pending.filter((d) => !done.includes(d));
    const next = copyFixture("team-app");
    copies.push(next);
    root = next.root;
  }
  applied = rounds.flatMap((r) => r.applied);
  after = rounds[0]?.after as Graph;
}, BUILD_TIMEOUT);

afterAll(() => {
  for (const c of copies) c.cleanup();
});

describe("deterministic fixes", () => {
  it("applies every patch fix (bottom-up) without conflicts", () => {
    const withPatch = before.diagnostics.filter((d) => d.fixes[0]?.patch).length;
    expect(applied.length).toBe(withPatch);
    expect(applied.map((d) => d.code).sort()).toEqual(["A2101", "A2101", "A2103", "A3002", "A3002", "A3006", "A3007", "A3010", "A4001", "A4002"]);
  });

  it("each fixed diagnostic is gone after the rebuild", () => {
    const key = (d: Diagnostic): string => `${d.code} ${d.node} ${d.title}`;
    expect(after).toBeDefined();
    for (const r of rounds) {
      const remaining = new Set(r.after.diagnostics.map(key));
      for (const d of r.applied) expect(remaining.has(key(d)), key(d)).toBe(false);
    }
  });

  it("the fixed declarations now verify (route-match after the A2101 path fix)", () => {
    const all: Graph["nodes"] = {};
    for (const r of rounds) for (const d of r.applied) if (r.after.nodes[d.node as never]) all[d.node as never] = r.after.nodes[d.node as never] as never;
    for (const r of rounds) if (r.after.nodes["Event:TeamArchived" as never]) all["Event:TeamArchived" as never] = r.after.nodes["Event:TeamArchived" as never] as never;
    const q = all["Query:Team.listInvites" as never] as { route: { verified: boolean; path: string } };
    expect(q.route).toMatchObject({ verified: true, path: "/teams/:teamId/invitations" });
    expect(all["Event:TeamArchived" as never]).toBeDefined();
    const rename = all["Action:Team.rename" as never] as { effects: { declared: string[] } };
    expect(rename.effects.declared).toEqual(["db:write"]);
  });

  it("A6001 has a command fix only", () => {
    const stale = before.diagnostics.filter((d) => d.code === "A6001");
    expect(stale.length).toBeGreaterThan(0);
    for (const d of stale) {
      expect(d.fixes).toHaveLength(1);
      expect(d.fixes[0]?.patch).toBeUndefined();
      expect(d.fixes[0]?.command).toBe(`averri testgen --only ${d.node}`);
    }
  });
});
