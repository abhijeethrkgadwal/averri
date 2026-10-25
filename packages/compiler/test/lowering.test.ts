/**
 * Static lowering fidelity: the contract ASTs the compiler derives WITHOUT executing anything must be
 * byte-identical (canonical JSON) to what the @averri/core builders produce at runtime for the same
 * declarations (copied from examples/seed-app). The test imports the modules; the compiler never does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { averriMeta, isDeclaration, type Declaration } from "@averri/core";
import { canonicalJson, type ActionNode, type ContractNode, type Graph, type PolicyNode, type EntityNode } from "@averri/ir";
import { build } from "../src/build.js";
import { BUILD_TIMEOUT, copyFixture, type FixtureCopy } from "./helpers.js";

let fx: FixtureCopy;
let graph: Graph;
const declarations: Declaration[] = [];

beforeAll(async () => {
  fx = copyFixture("seed-mini");
  graph = build(fx.root, { writeCache: false, git: false }).graph;
  for (const m of ["entities", "policies", "events", "actions", "queries", "workflows"]) {
    const mod = (await import(pathToFileURL(path.join(fx.root, "src/averri", `${m}.ts`)).href)) as Record<string, unknown>;
    for (const v of Object.values(mod)) if (isDeclaration(v)) declarations.push(v);
  }
}, BUILD_TIMEOUT);

afterAll(() => fx?.cleanup());

describe("static lowering matches the runtime builders", () => {
  it("lowers every declaration of the seed app", () => {
    const ids = new Set(declarations.map((d) => averriMeta(d).id));
    for (const id of ids) expect(graph.nodes[id as never], id).toBeDefined();
    expect(Object.values(graph.nodes).filter((n) => n.kind === "Action")).toHaveLength(11);
    expect(Object.values(graph.nodes).filter((n) => n.kind === "Query")).toHaveLength(4);
  });

  it("every contract AST equals the builder output (requires, ensures, invariants, allow)", () => {
    let compared = 0;
    for (const d of declarations) {
      const meta = averriMeta(d) as { contracts?: Array<{ id: string; expr: unknown; tier: string }> };
      for (const c of meta.contracts ?? []) {
        const node = graph.nodes[c.id as never] as ContractNode | undefined;
        expect(node, c.id).toBeDefined();
        expect(canonicalJson(node?.expr ?? null), c.id).toBe(canonicalJson(c.expr ?? null));
        expect(node?.tier, c.id).toBe(c.tier);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(70);
  });

  it("contract order, subject.where and policy tiers match", () => {
    for (const d of declarations) {
      const meta = averriMeta(d) as { id: string; kind: string; contracts?: Array<{ id: string }>; subject?: { where: unknown } | null };
      const node = graph.nodes[meta.id as never];
      if (meta.kind === "action") {
        const a = node as ActionNode;
        expect(a.contracts, meta.id).toEqual((meta.contracts ?? []).map((c) => c.id));
        expect(canonicalJson(a.subject?.where ?? null), meta.id).toBe(canonicalJson(meta.subject?.where ?? null));
      }
      if (meta.kind === "entity") {
        expect((node as EntityNode).invariants, meta.id).toEqual((meta.contracts ?? []).map((c) => c.id));
      }
      if (meta.kind === "policy") expect((node as PolicyNode).allow).toBe(meta.contracts?.[0]?.id);
    }
  });

  it("derives input field names from the Zod output type (through imported schemas and spreads)", () => {
    const listMembers = graph.nodes["Query:Org.listMembers" as never] as ActionNode;
    expect(listMembers.input.fields).toEqual(["orgId", "role", "limit", "cursor"]);
    const invite = graph.nodes["Action:Org.inviteMember" as never] as ActionNode;
    expect(invite.input.fields).toEqual(["orgId", "email", "role"]);
    expect(invite.input.zod).toMatchObject({ file: "src/averri/actions.ts", symbol: "InviteMember.input" });
  });

  it("binds every declared route to its Exposure and marks route.verified", () => {
    for (const n of Object.values(graph.nodes)) {
      if (n.kind !== "Action" && n.kind !== "Query") continue;
      const a = n as ActionNode;
      expect(a.route?.verified, a.id).toBe(true);
      const x = graph.nodes[a.route?.exposure as never] as { boundTo: string };
      expect(x.boundTo).toBe(a.id);
    }
  });

  it("only reports the genuine seed-app finding as an error", () => {
    const errors = graph.diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => `${d.code} ${d.node}`)).toEqual(["A3002 Contract:Org.createProject.ensures.startsEmpty"]);
  });
});
