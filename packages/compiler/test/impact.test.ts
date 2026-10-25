/**
 * impact / diff: affected nodes with their dependsOn edge path, tests to run, diff-hunk mapping,
 * structural diffs between two builds (weakening, removed policies, API breaks, migrations).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Graph } from "@averri/ir";
import { build } from "../src/build.js";
import { diff, impactOfDiff, impactOfGraphs, impactOfIds, resolveNodeId } from "../src/impact.js";
import { makePatch } from "../src/patch.js";
import { impactQuery } from "../src/query/impact.js";
import { buildWithDiffReverted } from "../src/revisions.js";
import { BUILD_TIMEOUT, copyFixture, type FixtureCopy } from "./helpers.js";

let base: FixtureCopy;
let baseGraph: Graph;
let head: FixtureCopy;
let headGraph: Graph;
let patch: string;

beforeAll(() => {
  base = copyFixture("team-app");
  baseGraph = build(base.root, { writeCache: false, git: false }).graph;
  head = copyFixture("team-app");
  const file = "src/averri/actions.ts";
  const before = head.read(file);
  // weaken: drop the precondition; change: route path; tighten an ensures by adding a conjunct
  let after = before.replace(
    '  requires: {\n    notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),\n  },\n',
    "",
  );
  after = after.replace('route: { method: "PATCH", path: "/teams/:teamId" }', 'route: { method: "PUT", path: "/teams/:teamId" }');
  head.write(file, after);
  head.edit("src/averri/policies.ts", 'export const Anyone = policy("Team.Anyone", {\n  allow: async ({ actor }) => actor.id !== "",\n});\n', "");
  head.edit("prisma/schema.prisma", "  seats      Int       @default(1)\n", "  seatCount  Int       @default(1)\n");
  headGraph = build(head.root, { writeCache: false, git: false }).graph;
  patch = makePatch(file, before, after) as string;
}, BUILD_TIMEOUT);

afterAll(() => {
  base?.cleanup();
  head?.cleanup();
});

describe("impact {id}", () => {
  it("an Entity change affects its writers, readers and contracts with a <= 2 hop path", () => {
    const r = impactOfIds(baseGraph, ["Entity:Invitation"]);
    expect(r.changed).toEqual(["Entity:Invitation"]);
    const invite = r.affected.find((a) => a.id === "Action:Team.inviteMember");
    expect(invite?.why).toEqual(["Entity:Invitation"]);
    const twoHop = r.affected.find((a) => a.why.length === 2);
    expect(twoHop).toBeDefined();
    expect(r.affected.every((a) => a.why.length >= 1 && a.why.length <= 2)).toBe(true);
    expect(r.migrationNeeded).toBe(true);
    expect(r.testsToRun.map((t) => t.id)).toContain("Test:gen/Team.inviteMember.auth-matrix");
  });

  it("a Policy change affects the actions it authorizes and their tests", () => {
    const r = impactOfIds(baseGraph, ["Policy:Team.OwnerOrAdmin"]);
    const ids = r.affected.map((a) => a.id);
    expect(ids).toContain("Action:Team.inviteMember");
    expect(ids).toContain("Query:Team.listInvites");
    expect(r.testsToRun.some((t) => t.suite === "auth-matrix")).toBe(true);
    expect(r.migrationNeeded).toBe(false);
  });

  it("resolves bare qualifiers and reports ambiguity", () => {
    expect(resolveNodeId(baseGraph, "Team.inviteMember")).toEqual({ ok: true, id: "Action:Team.inviteMember" });
    expect(resolveNodeId(baseGraph, "Invitation")).toEqual({ ok: true, id: "Entity:Invitation" });
    const amb = resolveNodeId(baseGraph, "MemberInvited");
    expect(amb.ok).toBe(true);
    const missing = resolveNodeId(baseGraph, "Action:Nope.nothing");
    expect(missing.ok).toBe(false);
  });

  it("refuses low-confidence targets (SPEC-MCP §5) and unknown ids", () => {
    const r = impactQuery(baseGraph, { id: "Nope.nothing" });
    expect(r.ok).toBe(false);
  });
});

describe("impact {diff}", () => {
  it("maps diff hunks to declarations through src ranges and Module.contains", () => {
    const r = impactOfDiff(headGraph, patch);
    expect(r.changed).toContain("Action:Team.inviteMember");
    expect(r.changed).toContain("Action:Team.rename");
    expect(r.changed).toContain("Module:src/averri/actions.ts");
  });

  it("with the reverted tree as base, reports weakening, removed policy and API breaks", () => {
    const reverted = buildWithDiffReverted(head.root, patch);
    expect(reverted.nodes["Contract:Team.inviteMember.requires.notAlreadyMember" as never]).toBeDefined();
    const r = impactOfDiff(headGraph, patch, reverted);
    expect(r.contractsWeakened).toContainEqual({ contract: "Contract:Team.inviteMember.requires.notAlreadyMember", op: "remove-contract" });
    expect(r.apiBreaking).toBe(true);
    expect(r.diff?.ops.length).toBeGreaterThan(0);
  }, BUILD_TIMEOUT);
});

describe("impact between two builds", () => {
  it("classifies the structural changes", () => {
    const r = impactOfGraphs(baseGraph, headGraph);
    expect(r.contractsWeakened).toContainEqual({ contract: "Contract:Team.inviteMember.requires.notAlreadyMember", op: "remove-contract" });
    expect(r.policiesRemoved).toEqual(["Policy:Team.Anyone"]);
    expect(r.apiBreaking).toBe(true);
    expect(r.migrationNeeded).toBe(true);
    expect(r.changed).toContain("Action:Team.rename");
    const d = diff(baseGraph, headGraph);
    expect(d.ops.some((o) => o.op === "remove" && o.node === "Field:Invitation.seats")).toBe(true);
    expect(d.ops.some((o) => o.op === "add" && o.node === "Field:Invitation.seatCount")).toBe(true);
  });

  it("an identical build has no impact", () => {
    const r = impactOfGraphs(baseGraph, baseGraph);
    expect(r.changed).toEqual([]);
    expect(r.message).toBe("nothing changed");
  });

  it("impactQuery bounds testsToRun to 20 with drill-down handles", () => {
    const r = impactQuery(headGraph, { base: "ignored" }, { baseGraph });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.testsToRun.length).toBeLessThanOrEqual(20);
      expect(JSON.stringify(r.data).length / 4).toBeLessThanOrEqual(1500);
      if (r.truncated) expect(r.more?.length).toBeGreaterThan(0);
    }
  });
});

describe("service modules named by a declaration's handler: (D-41c)", () => {
  let svc: FixtureCopy;
  let svcGraph: Graph;
  const file = "src/services/invites.ts";
  const source = [
    "// @ts-nocheck — fixture",
    'import { prisma } from "../db.js";',
    "",
    "export const PAGE_SIZE = 20;",
    "",
    "export async function listInvitationsHandler(c) {",
    "  const rows = await prisma.invitation.findMany({ where: { teamId: c.req.param(\"teamId\") } });",
    "  return c.json(rows);",
    "}",
    "",
  ].join("\n");

  beforeAll(() => {
    svc = copyFixture("team-app");
    svc.write(file, source);
    svc.edit("src/averri/actions.ts", 'import { listInvitationsHandler } from "../handlers.js";', 'import { listInvitationsHandler } from "../services/invites.js";');
    svcGraph = build(svc.root, { writeCache: false, git: false }).graph;
  }, BUILD_TIMEOUT);

  afterAll(() => svc?.cleanup());

  it("promotes the handler's Module to role `handler` so SPEC-IR §5 propagation fires", () => {
    const module = svcGraph.nodes[`Module:${file}` as never] as { role: string; summary: string } | undefined;
    expect(module?.role).toBe("handler");
    expect(module?.summary).toMatch(/^handler module /);
    expect(svcGraph.edges.some((e) => e.kind === "implementedBy" && e.from === "Query:Team.listInvites" && e.to === `Module:${file}`)).toBe(true);
  });

  it("an edit outside the handler span still affects the Query and selects its tests", () => {
    const patch = makePatch(file, source, source.replace("PAGE_SIZE = 20", "PAGE_SIZE = 50")) as string;
    const r = impactOfDiff(svcGraph, patch);
    expect(r.changed).toContain(`Module:${file}`);
    expect(r.affected.map((a) => a.id)).toContain("Query:Team.listInvites");
    expect(r.testsToRun.length).toBeGreaterThan(0);
  });
});

describe("undeclared Exposures and entity invariants in impact (D-41f)", () => {
  let fx: FixtureCopy;
  let g: Graph;
  const exposureId = (graph: Graph, path: string): string =>
    Object.keys(graph.nodes).find((id) => id.startsWith("Exposure:") && (graph.nodes[id as never] as { path: string }).path === path) as string;

  beforeAll(() => {
    fx = copyFixture("team-app");
    fx.write(
      "src/routes/resend.ts",
      [
        "// @ts-nocheck — fixture",
        'import { Hono } from "hono";',
        'import { prisma } from "../db.js";',
        "",
        "export const resendRoutes = new Hono();",
        "",
        'resendRoutes.post("/teams/:teamId/invitations/:id/resend", async (c) => {',
        "  const row = await prisma.invitation.update({ where: { id: c.req.param(\"id\") }, data: { status: \"pending\" } });",
        "  return c.json(row);",
        "});",
        'resendRoutes.get("/teams/:teamId/ping", (c) => c.json({ ok: true }));',
        "",
      ].join("\n"),
    );
    g = build(fx.root, { writeCache: false, git: false }).graph;
  }, BUILD_TIMEOUT);

  afterAll(() => fx?.cleanup());

  it("extracts reads/writes edges (origin extracted, confidence < 0.9) for a bare prisma call in an undeclared handler", () => {
    const id = exposureId(g, "/teams/:teamId/invitations/:id/resend");
    expect(id).toBeDefined();
    const edge = g.edges.find((e) => e.kind === "writes" && e.from === id && e.to === "Entity:Invitation");
    expect(edge).toBeDefined();
    expect(edge?.provenance.origin).toBe("extracted");
    if (edge?.provenance.origin === "extracted") expect(edge.provenance.confidence).toBeLessThan(0.9);
    // a handler that touches no model gets no edges
    const ping = exposureId(g, "/teams/:teamId/ping");
    expect(g.edges.some((e) => (e.kind === "writes" || e.kind === "reads") && e.from === ping)).toBe(false);
  });

  it("impact Entity:X lists the undeclared routes that write it and the entity's invariants", () => {
    const r = impactOfIds(g, ["Entity:Invitation"]);
    const ids = r.affected.map((a) => a.id);
    expect(ids).toContain(exposureId(g, "/teams/:teamId/invitations/:id/resend") as never);
    expect(ids).toContain("Contract:Invitation.invariant.pendingHasNoAcceptedAt");
    expect(ids).toContain("Contract:Invitation.invariant.seatsPositive");
    expect(r.affected.find((a) => a.id === "Contract:Invitation.invariant.seatsPositive")?.why).toEqual(["Entity:Invitation"]);
  });
});

describe("apiBreaking on Exposure moves and edits (D-41g)", () => {
  let moved: Graph;
  let edited: Graph;
  let methodEdited: Graph;
  const routes = "src/routes/teams.ts";
  const buildEdited = (edit: (fx: FixtureCopy) => void): Graph => {
    const fx = copyFixture("team-app");
    try {
      edit(fx);
      return build(fx.root, { writeCache: false, git: false }).graph;
    } finally {
      fx.cleanup();
    }
  };

  beforeAll(() => {
    // a new import line shifts every registration below it by one line
    moved = buildEdited((fx) => fx.edit(routes, 'import { Hono } from "hono";', 'import { Hono } from "hono";\nimport { prisma as unused } from "../db.js";'));
    edited = buildEdited((fx) => fx.edit(routes, 'teamRoutes.get("/teams/:teamId/stats"', 'teamRoutes.get("/teams/:teamId/statistics"'));
    methodEdited = buildEdited((fx) => fx.edit(routes, 'teamRoutes.get("/teams/:teamId/stats"', 'teamRoutes.post("/teams/:teamId/stats"'));
  }, BUILD_TIMEOUT * 2);

  it("registrations that only moved (same method and path) are not API-breaking", () => {
    // every Exposure id embeds line:col, so the diff sees ids change under it
    const d = diff(baseGraph, moved);
    expect(d.ops.some((o) => o.node.startsWith("Exposure:"))).toBe(true);
    expect(impactOfGraphs(baseGraph, moved).apiBreaking).toBe(false);
  });

  it("an in-place edit of an Exposure's path or method is API-breaking", () => {
    expect(impactOfGraphs(baseGraph, edited).apiBreaking).toBe(true);
    expect(impactOfGraphs(baseGraph, methodEdited).apiBreaking).toBe(true);
  });
});
