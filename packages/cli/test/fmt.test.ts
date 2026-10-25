import * as fs from "node:fs";
import * as path from "node:path";
import { Project } from "ts-morph";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalKeyOrder, formatSourceFile } from "../src/index.js";
import { cli, emptyDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const MESSY = `import { action, policy } from "@averri/core";
import { z } from "zod";

export const A = action("Team.rename", {
  // writes the team row
  effects: ["db:write"],
  input: z.object({ id: z.string() }),
  tags: ["teams"],
  route: { method: "PATCH", path: "/teams/:id" },
  intent: "Rename.",
  policy: P,
  run: async () => null,
});

export const P = policy("P", { owner: "me", allow: e.eq("actor.id", "x"), intent: "Anyone." });
`;

function fmtText(text: string): { output: string | null; changes: number } {
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile("x.ts", text);
  const r = formatSourceFile(sf, "x.ts");
  return { output: r.output, changes: r.changes.length };
}

describe("canonicalKeyOrder", () => {
  it("orders action keys by slot and keeps unknown keys behind their predecessor", () => {
    expect(canonicalKeyOrder("action", ["effects", "mystery", "input", "route", "intent"])).toEqual(["intent", "route", "input", "effects", "mystery"]);
  });
  it("treats policy|public and run|handler as one slot", () => {
    expect(canonicalKeyOrder("query", ["handler", "public", "input", "route"])).toEqual(["route", "input", "public", "handler"]);
  });
});

describe("formatSourceFile", () => {
  it("reorders, keeps each property's leading comment, and is idempotent", () => {
    const { output, changes } = fmtText(MESSY);
    expect(changes).toBe(2);
    expect(output).not.toBeNull();
    const keys = (s: string): string[] => [...s.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1] as string);
    const actionBlock = (output as string).split("export const P")[0] as string;
    expect(keys(actionBlock)).toEqual(["intent", "route", "input", "policy", "effects", "run", "tags"]);
    expect(actionBlock).toContain("  // writes the team row\n  effects:");
    expect(fmtText(output as string).output).toBeNull();
  });

  it("skips objects with spreads and files that do not import @averri/core", () => {
    expect(fmtText(`import { action } from "@averri/core";\nexport const A = action("A.b", { ...base, effects: [], input: i, intent: "x" });\n`).output).toBeNull();
    expect(fmtText(`const action = (..._a: unknown[]) => 0;\naction("A.b", { effects: [], intent: "x" });\n`).output).toBeNull();
  });

  it("handles namespace imports and aliases", () => {
    const a = fmtText(`import * as averri from "@averri/core";\nexport const A = averri.query("A.b", { handler: h, route: r });\n`);
    expect(a.output).toContain("route: r, handler: h");
    const b = fmtText(`import { query as q } from "@averri/core";\nexport const A = q("A.b", { handler: h, route: r });\n`);
    expect(b.changes).toBe(1);
  });
});

describe("averri fmt", () => {
  function project(): string {
    const d = emptyDir("fmt");
    cleanups.push(d.cleanup);
    fs.mkdirSync(path.join(d.root, "src/averri"), { recursive: true });
    fs.writeFileSync(path.join(d.root, "src/averri/a.ts"), MESSY);
    fs.writeFileSync(path.join(d.root, "src/plain.ts"), "export const x = 1;\n");
    return d.root;
  }

  it("--check reports and exits 1 without writing; fmt writes; a second --check is clean", async () => {
    const root = project();
    const before = fs.readFileSync(path.join(root, "src/averri/a.ts"), "utf8");
    const check = await cli(root, ["fmt", "--check", "--json"]);
    expect(check.code).toBe(1);
    const out = check.json();
    expect(out.changed).toEqual(["src/averri/a.ts"]);
    expect(out.written).toBe(false);
    expect(fs.readFileSync(path.join(root, "src/averri/a.ts"), "utf8")).toBe(before);
    const write = await cli(root, ["fmt"]);
    expect(write.code).toBe(0);
    expect(write.stdout).toContain("reordered src/averri/a.ts:4 action()");
    expect(fs.readFileSync(path.join(root, "src/averri/a.ts"), "utf8")).not.toBe(before);
    const again = await cli(root, ["fmt", "--check"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("0 need formatting");
  });

  it("accepts explicit files", async () => {
    const root = project();
    const r = await cli(root, ["fmt", "--check", "--json", "src/plain.ts"]);
    expect(r.code).toBe(0);
    expect(r.json().checked).toBe(0);
  });
});
