import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeValidateNode, type TestNode } from "@averri/ir";
import { extractProject, extractTests, loadProject, TEST_CONFIDENCE } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "fixtures/hono-app");
const result = extractProject(root, { entryPoints: ["src/app.ts"], include: { prisma: false, routes: false, zod: false } });
const tests = result.nodes.filter((n): n is TestNode => n.kind === "Test");
const byId = (id: string) => tests.find((t) => t.id === id)!;

describe("hand-written Vitest test discovery", () => {
  it("creates one Test node per it/test call with `<file>:<line>` ids and nested describe titles", () => {
    expect(tests.map((t) => t.id)).toEqual(["Test:tests/teams.spec.ts:10", "Test:tests/teams.spec.ts:15", "Test:tests/teams.spec.ts:6"]);
    expect(byId("Test:tests/teams.spec.ts:6")).toMatchObject({
      generated: false,
      suite: "hand-written",
      file: "tests/teams.spec.ts",
      title: "teams > invites a member",
      name: "teams > invites a member",
      lastResult: null,
      src: { file: "tests/teams.spec.ts", range: [[6, 2], [8, 4]] },
    });
    expect(byId("Test:tests/teams.spec.ts:10").title).toBe("teams > skipped one");
    expect(byId("Test:tests/teams.spec.ts:15").title).toBe("dynamic %i");
    for (const t of tests) expect(t.provenance).toMatchObject({ origin: "extracted", extractor: "vitest", confidence: TEST_CONFIDENCE.literal });
  });

  it("derives covers from file-level, describe-level and test-level @averri covers comments plus id literals", () => {
    expect(byId("Test:tests/teams.spec.ts:6").covers).toEqual([
      "Action:Team.inviteMember",
      "Policy:Team.OwnerOrAdmin",
      "Entity:Invitation",
      "Contract:Team.inviteMember.requires.notAlreadyMember",
    ]);
    expect(byId("Test:tests/teams.spec.ts:10").covers).toEqual(["Action:Team.inviteMember"]);
    expect(byId("Test:tests/teams.spec.ts:15").covers).toEqual(["Action:Team.inviteMember"]);
    const prov = byId("Test:tests/teams.spec.ts:6").provenance;
    expect(prov.origin === "extracted" && prov.evidence.map((e) => e.note)).toEqual([
      'it("invites a member") at tests/teams.spec.ts:6',
      "covers Action:Team.inviteMember, Policy:Team.OwnerOrAdmin, Entity:Invitation, Contract:Team.inviteMember.requires.notAlreadyMember",
    ]);
  });

  it("excludes generated tests under generatedDir from discovery, modules and the content hash (D-13)", () => {
    expect(tests.some((t) => t.file.startsWith("tests/averri/"))).toBe(false);
    expect(result.nodes.some((n) => n.kind === "Module" && n.file.startsWith("tests/averri/"))).toBe(false);
    expect(result.inputFiles.some((f) => f.path.startsWith("tests/averri/"))).toBe(false);
    expect(result.inputFiles.some((f) => f.path === "tests/teams.spec.ts")).toBe(true);
  });

  it("links tests to their Module with contains edges and a `test` role", () => {
    expect(result.edges.filter((e) => e.kind === "contains" && e.from === "Module:tests/teams.spec.ts").map((e) => e.to)).toEqual(tests.map((t) => t.id));
    expect(result.nodes.find((n) => n.id === "Module:tests/teams.spec.ts")).toMatchObject({ kind: "Module", role: "test" });
    expect(result.stack.testRunner).toBe("vitest");
    for (const t of tests) expect(safeValidateNode(t).ok).toBe(true);
  });

  it("lowers confidence for dynamic titles and files without a vitest import", () => {
    const ctx = loadProject(root, { include: { routes: false } });
    const rel = "tests/__virtual.spec.ts";
    const sf = ctx.project.createSourceFile(
      path.join(root, rel),
      'const name = () => "x";\ndescribe("suite", () => {\n  it(name(), () => {});\n  test("plain", () => {});\n});\n',
    );
    const out = extractTests(ctx, [rel]);
    expect(out.nodes.map((n) => [n.id, n.title, n.provenance.origin === "extracted" ? n.provenance.confidence : 0])).toEqual([
      ["Test:tests/__virtual.spec.ts:3", "suite > (dynamic)", TEST_CONFIDENCE.dynamicTitle],
      ["Test:tests/__virtual.spec.ts:4", "suite > plain", TEST_CONFIDENCE.noVitestImport],
    ]);
    expect(out.warnings).toEqual([expect.objectContaining({ code: "test-title-dynamic", file: rel })]);
    expect(out.testFiles).toEqual([rel]);
    sf.delete();
  });
});
