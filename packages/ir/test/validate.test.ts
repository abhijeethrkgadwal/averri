import { describe, expect, it } from "vitest";

import {
  GRAPH_SCHEMA_VERSION,
  GraphValidationError,
  diffGraphs,
  formatZodIssues,
  graphIntegrityIssues,
  safeValidateDiagnostic,
  safeValidateEdge,
  safeValidateExpr,
  safeValidateGraph,
  safeValidateGraphDiff,
  safeValidateNode,
  validateDiagnostic,
  validateEdge,
  validateExpr,
  validateGraph,
  validateGraphDiff,
  validateNode,
} from "../src/index.js";
import { clone, diagnostic, exampleGraph } from "./fixtures.js";

describe("validateGraph", () => {
  it("accepts the worked example", () => {
    const g = exampleGraph();
    expect(validateGraph(clone(g))).toEqual(g);
    expect(safeValidateGraph(clone(g)).ok).toBe(true);
  });
  it("rejects a schemaVersion mismatch with a rebuild hint", () => {
    const g = clone(exampleGraph());
    (g.meta as { schemaVersion: number }).schemaVersion = GRAPH_SCHEMA_VERSION + 1;
    const r = safeValidateGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatch(/meta\.schemaVersion: expected 1, got 2; the cache must be rebuilt/);
    expect(() => validateGraph(g)).toThrow(GraphValidationError);
    expect(() => validateGraph(g)).toThrow(/schemaVersion/);
  });
  it("rejects non-objects and missing meta", () => {
    expect(safeValidateGraph(null)).toEqual({ ok: false, issues: ["$: graph must be an object"] });
    expect(safeValidateGraph("x").ok).toBe(false);
    const r = safeValidateGraph({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatch(/schemaVersion/);
  });
  it("reports zod issues with readable paths", () => {
    const g = clone(exampleGraph());
    (g.nodes["Entity:Invitation"] as { model: unknown }).model = 42;
    g.edges[0]!.kind = "flies" as never;
    const r = safeValidateGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.startsWith("nodes.Entity:Invitation.model:"))).toBe(true);
      expect(r.issues.some((i) => i.startsWith("edges.[0].kind:"))).toBe(true);
    }
  });
  it("rejects key/id mismatch, bad counts and dangling edges", () => {
    const g = clone(exampleGraph());
    (g.nodes as Record<string, unknown>)["Entity:Wrong"] = { ...g.nodes["Entity:User"] };
    delete (g.nodes as Record<string, unknown>)["Entity:User"];
    const r = safeValidateGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContain('nodes.Entity:Wrong: key does not match node.id "Entity:User"');
      expect(r.issues.some((i) => i.includes('from "Entity:User" is not a node'))).toBe(true);
    }
    const h = clone(exampleGraph());
    h.meta.counts.Entity = 99;
    const r2 = safeValidateGraph(h);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.issues).toContain("meta.counts.Entity: expected 3 (from nodes), got 99");
      expect(r2.issues.some((i) => i.startsWith("meta.counts: sum"))).toBe(true);
    }
  });
  it("strict: false skips grammar and endpoint checks but keeps the counts invariant", () => {
    const g = clone(exampleGraph());
    g.edges.push({ kind: "reads", from: "Action:Team.inviteMember", to: "Entity:Ghost", provenance: g.edges[0]!.provenance });
    expect(safeValidateGraph(g).ok).toBe(false);
    expect(safeValidateGraph(g, { strict: false }).ok).toBe(true);
    const bad = clone(exampleGraph());
    (bad.nodes["Entity:User"] as { id: string }).id = "Entity:user";
    (bad.nodes as Record<string, unknown>)["Entity:user"] = bad.nodes["Entity:User"];
    delete (bad.nodes as Record<string, unknown>)["Entity:User"];
    const issues = graphIntegrityIssues(bad, true);
    expect(issues.some((i) => i.includes("PascalCase"))).toBe(true);
    expect(graphIntegrityIssues(bad, false).some((i) => i.includes("PascalCase"))).toBe(false);
  });
  it("GraphValidationError lists at most 10 issues inline and keeps all in .issues", () => {
    const err = new GraphValidationError("graph", Array.from({ length: 13 }, (_, i) => `issue ${i}`));
    expect(err.issues).toHaveLength(13);
    expect(err.message).toContain("... and 3 more");
    expect(err.name).toBe("GraphValidationError");
  });
});

describe("other validators", () => {
  it("node / edge / expr / diagnostic / diff", () => {
    const g = exampleGraph();
    expect(validateNode(clone(g.nodes["Entity:User"]))).toEqual(g.nodes["Entity:User"]);
    expect(safeValidateNode({ kind: "Entity" }).ok).toBe(false);
    expect(() => validateNode({})).toThrow(GraphValidationError);
    expect(validateEdge(clone(g.edges[0]))).toEqual(g.edges[0]);
    expect(safeValidateEdge({ kind: "reads" }).ok).toBe(false);
    expect(() => validateEdge({})).toThrow(/edge is invalid/);
    const expr = { op: "eq", lhs: { ref: "input.a" }, rhs: { lit: 1 } };
    expect(validateExpr(expr)).toEqual(expr);
    expect(safeValidateExpr({ op: "and", args: [] }).ok).toBe(false);
    expect(safeValidateExpr({ op: "eq", lhs: { ref: "nope.a" }, rhs: { lit: 1 } }).ok).toBe(false);
    expect(() => validateExpr({ op: "zzz" })).toThrow(/contract expression is invalid/);
    const d = diagnostic("D-0001", "A1001", "error", { docs: "averri://docs/identity" });
    expect(validateDiagnostic(clone(d))).toEqual(d);
    expect(safeValidateDiagnostic({ ...d, code: "A0000" }).ok).toBe(false);
    expect(safeValidateDiagnostic({ ...d, fixes: [{ label: "x", evidence: "y" }] }).ok).toBe(false);
    expect(() => validateDiagnostic({})).toThrow(/diagnostic is invalid/);
    const diff = diffGraphs(g, g);
    expect(validateGraphDiff(clone(diff))).toEqual(diff);
    expect(safeValidateGraphDiff({ ops: [] }).ok).toBe(false);
    expect(() => validateGraphDiff({})).toThrow(/graph diff is invalid/);
  });
  it("formatZodIssues renders paths", () => {
    const r = safeValidateNode({ kind: "Event", id: "Event:X", name: "X", summary: "s", provenance: { origin: "declared" }, src: null, payload: { a: "nope" }, external: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.startsWith("payload.a:"))).toBe(true);
      expect(r.issues.some((i) => i.startsWith("provenance.declaredAt:"))).toBe(true);
    }
    expect(formatZodIssues({ issues: [{ path: [], message: "m" }] } as never)).toEqual(["$: m"]);
  });
});
