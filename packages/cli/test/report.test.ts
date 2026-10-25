import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReport } from "../src/index.js";
import { cli, copyFixture } from "./helpers.js";

const fx = copyFixture("team-app");
const root = fx.root;
afterAll(() => fx.cleanup());

const git = (...args: string[]): string => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });

beforeAll(() => {
  fs.writeFileSync(path.join(root, ".gitignore"), ".averri/\nnode_modules/\ntests/averri/\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
}, 60_000);

describe("report", () => {
  it("--base outside git history is a usage error (exit 2)", async () => {
    const r = await cli(root, ["report", "--base", "no-such-ref", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json()).toMatchObject({ ok: false, error: "bad-input" });
  }, 120_000);

  it("reports the graph change, impact and introduced diagnostics against HEAD, and writes .averri/reports", async () => {
    const file = path.join(root, "src/averri/actions.ts");
    const text = fs.readFileSync(file, "utf8");
    // Drop the notAlreadyMember precondition: a weakened contract.
    const weakened = text.replace(/  requires: \{\n    notAlreadyMember:[^\n]*\n  \},\n/, "");
    expect(weakened).not.toBe(text);
    fs.writeFileSync(file, weakened);
    const r = await cli(root, ["report", "--base", "HEAD", "--json"]);
    const j = r.json();
    expect(j.ok).toBe(true);
    expect(j.base.ref).toBe("HEAD");
    expect(j.summary).toMatch(/contract/);
    expect(j.impact.contractsWeakened.map((w: { contract: string }) => w.contract)).toContain("Contract:Team.inviteMember.requires.notAlreadyMember");
    expect(j.impact.diff).toBeUndefined();
    expect(j.diagnostics.counts.errors).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(root, ".averri/reports")).length).toBe(1);
    const human = await cli(root, ["report", "--base", "HEAD"]);
    expect(human.stdout).toContain("Report HEAD..");
    expect(human.stdout).toContain("contract remove-contract");
  }, 240_000);
});

describe("buildReport", () => {
  it("is a pure function of two graphs: identical graphs give an empty report", async () => {
    const graph = JSON.parse(fs.readFileSync(path.join(root, ".averri/graph.json"), "utf8"));
    const r = buildReport(graph, graph, "x");
    expect(r.summary).toBe("no changes");
    expect(r.diagnostics.introduced).toEqual([]);
    expect(r.diagnostics.resolved).toEqual([]);
    expect(r.impact.contractsWeakened).toEqual([]);
  });
});
