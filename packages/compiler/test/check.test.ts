/**
 * check: tsc cascade collapse (diff-scoped heuristic), Vitest result mapping (A9002, rerun, lastResult),
 * last-check.json / last-green.json, the green rule, and a real tsc run on a tiny project.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Diagnostic, Graph } from "@averri/ir";
import { build } from "../src/build.js";
import { readLastCheck, readLastGreen } from "../src/cache.js";
import { boundCheck, check, type CheckData } from "../src/check/check.js";
import { collapseTscErrors, diffSymbols, usefulTitle } from "../src/check/tsc-collapse.js";
import { runTsc, type TscError } from "../src/check/tsc.js";
import { parseVitestJson, rerunCommand, testIdOf, type VitestReport } from "../src/check/vitest.js";
import { explain } from "../src/explain.js";
import { MORE_CAP, responseTokens } from "../src/query/budget.js";
import { makePatch } from "../src/patch.js";
import { BUILD_TIMEOUT, copyFixture, TMP, type FixtureCopy } from "./helpers.js";

let fx: FixtureCopy;
let graph: Graph;

beforeAll(() => {
  fx = copyFixture("seed-mini");
  graph = build(fx.root, { writeCache: true, writeTests: true, git: false }).graph;
}, BUILD_TIMEOUT);

afterAll(() => fx?.cleanup());

describe("tsc cascade collapse", () => {
  const errors: TscError[] = [
    { file: "src/a.ts", line: 3, column: 2, code: 2339, message: "Property 'teamId' does not exist on type 'Invitation'." },
    { file: "src/b.ts", line: 9, column: 4, code: 2339, message: "Property 'teamId' does not exist on type 'Invitation'." },
    { file: "src/c.ts", line: 1, column: 0, code: 2304, message: "Cannot find name 'teamId'." },
    ...Array.from({ length: 12 }, (_, i) => ({ file: "src/z.ts", line: i + 1, column: 0, code: 2322, message: `Type 'string' is not assignable to type 'number'. (${i})` })),
  ];
  const diffText = makePatch("prisma/schema.prisma", "model Invitation {\n  teamId String\n}\n", "model Invitation {\n  organizationId String\n}\n") as string;

  it("collects introduced/removed symbols from a unified diff", () => {
    const syms = diffSymbols(diffText, null);
    expect(syms.map((s) => `${s.change}${s.name}`).sort()).toEqual(["+organizationId", "-teamId"]);
    const ts = diffSymbols(makePatch("src/x.ts", "export const a = 1;\n", "export const b = 1;\nexport function c() {}\n") as string, null);
    expect(ts.map((s) => s.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("groups errors naming a diff symbol into one A9001; caps ungrouped at 10 + a summary", () => {
    const out = collapseTscErrors(errors, { graph: null, symbols: diffSymbols(diffText, null) });
    expect(out.every((d) => d.code === "A9001" && d.fixes.length === 0)).toBe(true);
    const grouped = out[0];
    expect(grouped?.title).toBe("Property 'teamId' does not exist on type 'Invitation'.");
    expect(grouped?.message).toBe("+2 more errors reference 'teamId'");
    expect(out).toHaveLength(1 + 10 + 1);
    expect(out[out.length - 1]?.title).toBe("2 more TypeScript errors");
  });

  it("uses the useful overload line for TS2769 on a core constructor", () => {
    const e: TscError = {
      file: "src/x.ts",
      line: 1,
      column: 0,
      code: 2769,
      message: "No overload matches this call.\n  Overload 1 of 4, '(id, options)', gave the following error.\n    Object literal may only specify known properties, and 'polcy' does not exist in type 'Options'.",
    };
    const title = usefulTitle(e, 'export const X = action("A.b", {');
    expect(title.startsWith("Object literal may only specify known properties, and 'polcy'")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(usefulTitle(e, "foo(1)")).toBe("No overload matches this call.");
  });

  it("runs the real compiler on a tiny project", () => {
    const dir = path.join(TMP, `tsc-${process.pid}-${Date.now().toString(36)}`);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/a.ts"), "export const n: number = 'x';\n");
    try {
      const errs = runTsc(dir);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({ file: "src/a.ts", line: 1, code: 2322 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, BUILD_TIMEOUT);
});

describe("vitest mapping", () => {
  it("parses the JSON reporter and maps titles to Test nodes", () => {
    const assertions = parseVitestJson(fx.root, {
      testResults: [
        {
          name: path.join(fx.root, "tests/averri/Org.inviteMember.gen.test.ts"),
          assertionResults: [
            {
              ancestorTitles: ["[Test:gen/Org.inviteMember.precondition] Org.inviteMember"],
              title: "[Contract:Org.inviteMember.requires.notAlreadyMember] violation is rejected",
              status: "failed",
              failureMessages: ["AssertionError: expected 201 to be 412"],
            },
          ],
        },
      ],
    });
    expect(assertions[0]).toMatchObject({ file: "tests/averri/Org.inviteMember.gen.test.ts", status: "failed" });
    expect(testIdOf(graph, assertions[0]!)).toBe("Test:gen/Org.inviteMember.precondition");
    expect(rerunCommand(assertions[0]!)).toBe(
      'npx vitest run tests/averri/Org.inviteMember.gen.test.ts -t "\\\\[Contract:Org\\\\.inviteMember\\\\.requires\\\\.notAlreadyMember\\\\] violation is rejected"',
    );
  });
});

describe("check()", () => {
  const failing: VitestReport = {
    ok: false,
    assertions: [
      {
        file: "tests/averri/Org.inviteMember.gen.test.ts",
        title: "[Test:gen/Org.inviteMember.precondition] Org.inviteMember > [Contract:Org.inviteMember.requires.notAlreadyMember] violation is rejected",
        status: "failed",
        failureMessages: ["AssertionError: expected 201 to be 412"],
        line: 40,
      },
      { file: "tests/averri/Org.inviteMember.gen.test.ts", title: "[Test:gen/Org.inviteMember.auth-matrix] Org.inviteMember > anonymous", status: "passed", failureMessages: [], line: 20 },
    ],
  };

  it("maps failures to A9002 with rerun commands and records last-check", async () => {
    const r = await check(fx.root, { scope: "all", git: false, tsc: () => [], vitest: () => failing, baseGraph: null });
    expect(r.data.green).toBe(false);
    expect(r.data.tests).toMatchObject({ ran: 2, passed: 1, failed: 1 });
    expect(r.data.tests.failures[0]).toMatchObject({
      testId: "Test:gen/Org.inviteMember.precondition",
      contract: "Contract:Org.inviteMember.requires.notAlreadyMember",
    });
    const a9002 = r.data.diagnostics.find((d) => d.code === "A9002");
    expect(a9002).toMatchObject({ node: "Test:gen/Org.inviteMember.precondition", severity: "error" });
    expect(a9002?.fixes).toEqual([]);
    const last = readLastCheck(fx.root);
    expect(last?.meta.contentHash).toBe(r.graph.meta.contentHash);
    expect(last?.tests.find((t) => t.status === "failed")?.failedContracts).toEqual(["Contract:Org.inviteMember.requires.notAlreadyMember"]);
    const t = r.graph.nodes["Test:gen/Org.inviteMember.precondition" as never] as { lastResult: { status: string } };
    expect(t.lastResult.status).toBe("failed");
    expect(readLastGreen(fx.root)).toBeNull();
    // explain resolves the diagnostic id from last-check.json
    const ex = explain(r.graph, { diagId: a9002?.id as string }, { root: fx.root, blame: false });
    expect(ex.ok).toBe(true);
    if (ex.ok) expect(ex.data.subject.kind).toBe("diagnostic");
    // and the failing test
    const et = explain(r.graph, { testId: "Test:gen/Org.inviteMember.precondition" }, { root: fx.root, blame: false });
    expect(et.ok).toBe(true);
    if (et.ok) {
      expect(et.data.failure).toMatchObject({ actual: "AssertionError: expected 201 to be 412" });
      expect(et.data.chain.map((c) => c.role)).toEqual(expect.arrayContaining(["exposure", "route", "policy", "contract", "test"]));
      expect(et.data.rerun).toContain("npx vitest run tests/averri/Org.inviteMember.gen.test.ts -t");
    }
  }, BUILD_TIMEOUT);

  it("a tsc error makes check red and is collapsed into A9001", async () => {
    const r = await check(fx.root, {
      scope: "all",
      git: false,
      tsc: () => [{ file: "src/averri/actions.ts", line: 40, column: 2, code: 2322, message: "Type 'string' is not assignable to type 'number'." }],
      vitest: false,
      baseGraph: null,
    });
    const a9001 = r.data.diagnostics.find((d) => d.code === "A9001");
    // line 40 is `output: Invitation,` inside the Org.inviteMember declaration: the smallest node containing it
    expect(a9001?.node).toBe("Action:Org.inviteMember");
    expect(a9001?.path).toBe("src/averri/actions.ts:40");
    expect(r.data.green).toBe(false);
  }, BUILD_TIMEOUT);

  it("green when only the known compiler error is acknowledged away: weakened contracts block green", async () => {
    // Remove the seed app's one error (A3002) so the build is clean, then compare against a base with an extra clause.
    fx.edit("src/averri/actions.ts", '    startsEmpty: e.eq("result.taskCount", 0),\n', "");
    const base = build(fx.root, { writeCache: false, git: false }).graph;
    fx.edit("src/averri/actions.ts", '    nameAsRequested: e.eq("result.name", e.input("name")),\n', "");
    const r = await check(fx.root, { scope: "affected", git: false, tsc: () => [], vitest: () => ({ ok: true, assertions: [] }), baseGraph: base });
    expect(r.data.contractsWeakened).toEqual([{ contract: "Contract:Org.createProject.ensures.nameAsRequested", op: "remove-contract" }]);
    expect(r.data.green).toBe(false);
    expect(r.data.coverage.message).toMatch(/cover your change|no test/);
    const ack = await check(fx.root, { scope: "affected", git: false, tsc: () => [], vitest: () => ({ ok: true, assertions: [] }), baseGraph: base, acknowledgeWeakening: true });
    expect(ack.data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(ack.data.green).toBe(true);
    const lg = readLastGreen(fx.root);
    expect(lg?.snapshot).toBe(`snapshots/${ack.graph.meta.contentHash}.json`);
    expect(fs.existsSync(path.join(fx.root, ".averri", lg?.snapshot as string))).toBe(true);
  }, BUILD_TIMEOUT);
});

describe("check(): response budget (D-41d)", () => {
  const diag = (n: number, code: string, title: string, node: string | null): Diagnostic => ({
    id: `D:${code}:${n}` as never,
    code: code as never,
    severity: "warning",
    title,
    message: "x".repeat(40),
    node: node as never,
    path: null,
    src: null,
    cause: [],
    related: [],
    fixes: [],
    since_last_green: null,
    docs: null,
  });
  const base = (diagnostics: Diagnostic[], tests = 150): CheckData => ({
    diagnostics,
    tests: { ran: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
    coverage: {
      generated: tests,
      handWritten: 0,
      message: "m",
      tests: Array.from({ length: tests }, (_, i) => ({ id: `Test:gen/Some.Long.Owner.Name${i}.precondition` as never, suite: "precondition", file: `tests/averri/Owner${i}.gen.test.ts`, generated: true })),
    },
    contractsWeakened: [],
    policiesRemoved: [],
    green: true,
  });

  it("measures `more` and the envelope: a long drop list cannot exceed the budget and is capped", () => {
    const diagnostics = Array.from({ length: 12 }, (_, i) => diag(i, "A2104", "Exposure has no declaration", `Exposure:GET /route/${i}:${i}:1`));
    const bounded = boundCheck(base(diagnostics));
    expect(bounded.truncated).toBe(true);
    expect(responseTokens(bounded.data, bounded.more)).toBeLessThanOrEqual(2000);
    expect(bounded.more.length).toBeLessThanOrEqual(MORE_CAP);
    expect(bounded.more.at(-1)).toMatch(/^\+\d+ more$/);
    expect(bounded.data.coverage.tests.length).toBeLessThanOrEqual(20);
  });

  it("collapses repeated diagnostics of one code and title, naming the nodes in `more`", () => {
    const repeated = Array.from({ length: 30 }, (_, i) => diag(i, "A2104", "Exposure has no declaration", `Exposure:GET /route/${i}:${i}:1`));
    const distinct = diag(99, "A2103", "Exposure without policy", "Exposure:POST /x:1:1");
    const bounded = boundCheck(base([...repeated, distinct], 40));
    expect(bounded.data.diagnostics.map((d) => d.code)).toEqual(["A2104", "A2103"]);
    expect(bounded.data.diagnostics[0]?.message).toMatch(/\+29 more with the same code and title/);
    expect(bounded.more[0]).toBe("Exposure:GET /route/1:1:1");
    expect(responseTokens(bounded.data, bounded.more)).toBeLessThanOrEqual(2000);
  });

  it("leaves a response that fits untouched", () => {
    const small = base([diag(0, "A2104", "t", null)], 3);
    const bounded = boundCheck(small);
    expect(bounded.truncated).toBe(false);
    expect(bounded.more).toEqual([]);
    expect(bounded.data).toEqual(small);
  });
});

describe("check(): hand-written tests by import closure (D-41e)", () => {
  let tfx: FixtureCopy;
  let before: Graph;
  const service = 'export function greet(name: string) {\n  return `hello ${name}`;\n}\n';

  beforeAll(() => {
    tfx = copyFixture("team-app");
    tfx.write("src/services/greet.ts", service);
    tfx.write("src/services/other.ts", "export const other = 1;\n");
    tfx.write(
      "tests/greet.spec.ts",
      '// @ts-nocheck — fixture hand-written test, no `@averri covers` header\nimport { describe, expect, it } from "vitest";\nimport { greet } from "../src/services/greet.js";\n\ndescribe("greet", () => {\n  it("greets", () => {\n    expect(greet("a")).toBe("hello a");\n  });\n});\n',
    );
    tfx.write(
      "tests/other.spec.ts",
      '// @ts-nocheck — fixture hand-written test\nimport { describe, expect, it } from "vitest";\nimport { other } from "../src/services/other.js";\n\ndescribe("other", () => {\n  it("is one", () => {\n    expect(other).toBe(1);\n  });\n});\n',
    );
    before = build(tfx.root, { writeCache: false, git: false }).graph;
  }, BUILD_TIMEOUT);

  afterAll(() => tfx?.cleanup());

  it("selects the tests that import a changed service file, even without covers, and says what was skipped", async () => {
    tfx.edit("src/services/greet.ts", "hello ${name}", "hi ${name}");
    let ran: string[] = [];
    const r = await check(tfx.root, {
      scope: "affected",
      git: false,
      tsc: false,
      vitest: (_root, files) => {
        ran = [...(files ?? [])];
        return { ok: true, assertions: [] };
      },
      baseGraph: before,
    });
    expect(ran).toContain("tests/greet.spec.ts");
    expect(ran).not.toContain("tests/other.spec.ts");
    expect(r.data.coverage.message).toMatch(/hand-written tests cover your change/);
    expect(r.data.coverage.message).toMatch(/hand-written tests in \d+ files were not selected/);
  }, BUILD_TIMEOUT);
});
