import { describe, expect, it } from "vitest";

import { computeHealth, hasAuthMiddleware, healthRatios, middlewareCallee } from "../src/index.js";
import { clone, exampleGraph, exposure, graph, test } from "./fixtures.js";

describe("middlewareCallee / hasAuthMiddleware", () => {
  it("extracts the bare callee", () => {
    expect(middlewareCallee("auth()")).toBe("auth");
    expect(middlewareCallee('requireRole("admin")')).toBe("requireRole");
    expect(middlewareCallee("auth")).toBe("auth");
    expect(middlewareCallee(" mw.auth() ")).toBe("auth");
    expect(hasAuthMiddleware(["cors()", "auth()"], ["auth"])).toBe(true);
    expect(hasAuthMiddleware(["cors()"], ["auth"])).toBe(false);
    expect(hasAuthMiddleware(["auth()"], [])).toBe(false);
  });
});

describe("computeHealth", () => {
  it("matches the SPEC-IR §8 definitions on the worked example", () => {
    const g = exampleGraph();
    const h = computeHealth(g, { authMiddleware: ["auth"] });
    expect(h).toEqual({
      exposures: 3,
      exposuresWithoutPolicy: 1, // /health: unbound, not public, no auth middleware
      exposuresUndeclared: 2,
      actionsDeclared: 1,
      actionsObserve: 0,
      queries: 1,
      contracts: 6,
      opaqueGuards: 1,
      handlerLines: 13,
      totalLines: 180, // test module excluded
      eventsWithoutConsumer: 1,
      staleGeneratedTests: 0,
      lowConfidenceNodes: 0,
      errors: 0,
      warnings: 3,
    });
  });
  it("without authMiddleware config every unbound non-public exposure lacks a policy", () => {
    const h = computeHealth(exampleGraph());
    expect(h.exposuresWithoutPolicy).toBe(2);
  });
  it("public exposures, observe actions, low confidence, external events, stale tests", () => {
    const g = clone(exampleGraph());
    (g.nodes["Exposure:hono:src/routes/health.ts:3:4"] as { public: boolean }).public = true;
    (g.nodes["Action:Team.inviteMember"] as { mode: string }).mode = "observe";
    (g.nodes["Event:Orphan"] as { external: boolean }).external = true;
    (g.nodes["Exposure:hono:src/routes/teams.ts:50:4"] as { provenance: { confidence: number } }).provenance.confidence = 0.6;
    g.diagnostics.push({ ...g.diagnostics[0]!, id: "D-0004", severity: "error" }, { ...g.diagnostics[0]!, id: "D-0005", severity: "info" });
    const h = computeHealth(g, { authMiddleware: ["auth"], staleGeneratedTests: (t) => t.sourceHash === "abc" });
    expect(h.exposuresWithoutPolicy).toBe(0);
    expect(h.actionsDeclared).toBe(0);
    expect(h.actionsObserve).toBe(1);
    expect(h.eventsWithoutConsumer).toBe(0);
    expect(h.lowConfidenceNodes).toBe(1);
    expect(h.staleGeneratedTests).toBe(1);
    expect(h.errors).toBe(1);
    expect(h.warnings).toBe(3);
    expect(computeHealth(g, { staleGeneratedTests: 7 }).staleGeneratedTests).toBe(7);
    expect(computeHealth(g, { confidenceThreshold: 0.5 }).lowConfidenceNodes).toBe(0);
  });
  it("hand-written tests are never counted as stale", () => {
    const g = graph([test("Test:tests/a.test.ts:1", [])]);
    expect(computeHealth(g, { staleGeneratedTests: () => true }).staleGeneratedTests).toBe(0);
  });
  it("bound exposures never count as without-policy", () => {
    const g = graph([exposure("src/a.ts", 1, 0, "GET", "/x", { boundTo: "Action:Team.x" })]);
    const h = computeHealth(g);
    expect(h.exposures).toBe(1);
    expect(h.exposuresUndeclared).toBe(0);
    expect(h.exposuresWithoutPolicy).toBe(0);
  });
  it("healthRatios", () => {
    const h = computeHealth(exampleGraph());
    expect(healthRatios(h)).toEqual({ opaqueGuardRatio: 1 / 6, handlerLineRatio: 13 / 180 });
    expect(healthRatios({ ...h, contracts: 0, totalLines: 0 })).toEqual({ opaqueGuardRatio: null, handlerLineRatio: null });
  });
});
