/**
 * The team-app fixture: one deliberate mistake per rule. Asserts the graph (nodes, edges, provenance,
 * verifiers), the diagnostics against a golden JSON file, and the diagnostic invariants (registry
 * severity cap, fix rule, budget, patch dry-run).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  diagnosticConsistencyIssues,
  hasEdge,
  serializeGraph,
  validateGraph,
  type ActionNode,
  type EventNode,
  type ExposureNode,
  type Graph,
  type IntegrationNode,
  type PolicyNode,
  type QueryNode,
  type TestNode,
  type WorkflowNode,
} from "@averri/ir";
import { build } from "../src/build.js";
import { budgetSize, DIAGNOSTIC_CHAR_BUDGET } from "../src/diagnostics.js";
import { patchApplies } from "../src/patch.js";
import { BUILD_TIMEOUT, copyFixture, goldenDiagnostics, matchGolden, type FixtureCopy } from "./helpers.js";

let fx: FixtureCopy;
let graph: Graph;

beforeAll(() => {
  fx = copyFixture("team-app");
  graph = build(fx.root, { writeCache: false, git: false, now: () => new Date("2026-10-25T00:00:00Z") }).graph;
}, BUILD_TIMEOUT);

afterAll(() => fx?.cleanup());

const node = <T>(id: string): T => graph.nodes[id as never] as T;

describe("team-app graph", () => {
  it("validates strictly and has the expected node counts", () => {
    expect(() => validateGraph(JSON.parse(serializeGraph(graph)))).not.toThrow();
    expect(graph.meta.counts).toMatchObject({ Entity: 4, Action: 5, Query: 3, Policy: 2, Event: 3, Workflow: 1, Integration: 1, Exposure: 9 });
    expect(graph.meta.stack).toMatchObject({ orm: "prisma", routers: ["hono"], validator: "zod", entryPoints: ["src/app.ts"] });
  });

  it("a fully consistent declared-mode action is verified by every applicable verifier", () => {
    const a = node<ActionNode>("Action:Team.inviteMember");
    expect(a.provenance).toMatchObject({ origin: "verified", verifiers: ["route-match", "effect-scan", "emit-scan", "zod-match"] });
    expect(a.mode).toBe("declared");
    expect(a.transaction).toBe(true);
    expect(a.route).toEqual({ method: "POST", path: "/teams/:teamId/invitations", exposure: "Exposure:hono:src/routes/teams.ts:12:11", verified: true });
    expect(a.effects.verified).toEqual({ reads: [], writes: ["Entity:Invitation"], emits: ["Event:MemberInvited"], calls: [], complete: true });
    expect(a.handler).toMatchObject({ file: "src/averri/actions.ts", symbol: "InviteMember.run" });
    expect(a.idempotency).toEqual({ key: { header: "idempotency-key" }, ttlSeconds: 86400 });
    expect(a.input.fields).toEqual(["teamId", "email", "role"]);
    expect(a.output).toEqual({ entity: "Entity:Invitation" });
    expect(a.ratios).toMatchObject({ totalContracts: 3, opaqueGuards: 0 });
    for (const [kind, from, to] of [
      ["authorizes", "Policy:Team.OwnerOrAdmin", "Action:Team.inviteMember"],
      ["exposes", "Exposure:hono:src/routes/teams.ts:12:11", "Action:Team.inviteMember"],
      ["writes", "Action:Team.inviteMember", "Entity:Invitation"],
      ["emits", "Action:Team.inviteMember", "Event:MemberInvited"],
      ["returns", "Action:Team.inviteMember", "Entity:Invitation"],
      ["constrains", "Contract:Team.inviteMember.requires.notAlreadyMember", "Action:Team.inviteMember"],
      ["reads", "Contract:Team.inviteMember.requires.notAlreadyMember", "Entity:Membership"],
      ["reads", "Policy:Team.OwnerOrAdmin", "Entity:Membership"],
      ["consumedBy", "Event:MemberInvited", "Workflow:InviteFlow"],
      ["contains", "Module:src/averri/actions.ts", "Action:Team.inviteMember"],
      ["implementedBy", "Action:Team.inviteMember", "Module:src/averri/actions.ts"],
      ["validatesWith", "Action:Team.inviteMember", "Module:src/averri/actions.ts"],
      ["verifiedBy", "Action:Team.inviteMember", "Test:gen/Team.inviteMember.auth-matrix"],
      ["verifiedBy", "Action:Team.inviteMember", "Test:tests/teams.spec.ts:6"],
      ["dependsOn", "Action:Team.inviteMember", "Entity:Invitation"],
    ] as const) {
      expect(hasEdge(graph.edges, kind, from, to), `${kind} ${from} -> ${to}`).toBe(true);
    }
    const ex = node<ExposureNode>("Exposure:hono:src/routes/teams.ts:12:11");
    expect(ex.boundTo).toBe("Action:Team.inviteMember");
    expect(ex.middleware).toEqual(["auth"]);
  });

  it("lowers the contract AST exactly (nested where flattened, bare paths rooted at self)", () => {
    expect(node<{ expr: unknown }>("Contract:Team.inviteMember.requires.notAlreadyMember").expr).toEqual({
      op: "db.none",
      model: "membership",
      where: { teamId: { ref: "input.teamId" }, "user.email": { ref: "input.email" } },
    });
    expect(node<{ expr: unknown }>("Contract:Invitation.invariant.pendingHasNoAcceptedAt").expr).toEqual({
      op: "or",
      args: [
        { op: "ne", lhs: { ref: "self.status" }, rhs: { lit: "pending" } },
        { op: "isNull", arg: { ref: "self.acceptedAt" } },
      ],
    });
    expect(node<{ expr: unknown }>("Contract:Team.inviteMember.ensures.eventEmitted").expr).toEqual({ op: "emitted", event: "Event:MemberInvited", count: 1 });
  });

  it("policies, events, workflows and integrations", () => {
    const p = node<PolicyNode>("Policy:Team.OwnerOrAdmin");
    expect(p.tier).toBe("predicate");
    expect(p.allow).toBe("Contract:Team.OwnerOrAdmin.allow");
    expect(p.appliesTo).toContain("Action:Team.inviteMember");
    expect(p.appliesTo).toContain("Exposure:hono:src/routes/teams.ts:12:11");
    expect(node<PolicyNode>("Policy:Team.Anyone").tier).toBe("guard");
    expect(node<EventNode>("Event:MemberInvited").provenance).toMatchObject({ origin: "verified", verifiers: ["consumer-scan"] });
    expect(node<EventNode>("Event:Audited").external).toBe(true);
    const w = node<WorkflowNode>("Workflow:InviteFlow");
    expect(w).toMatchObject({ on: "Event:MemberInvited", engine: "custom", steps: ["load", "email"], retry: { attempts: 3, backoff: "fixed" } });
    expect(w.runner).toMatchObject({ file: "src/jobs.ts", symbol: "inviteRunner" });
    const i = node<IntegrationNode>("Integration:Stripe");
    expect(i.webhook).toEqual({ verify: "stripe-signature", scheme: "stripe", secretEnv: "STRIPE_WEBHOOK_SECRET", rawBody: true, exposure: "Exposure:hono:src/routes/webhooks.ts:6:14" });
    expect(i.client).toMatchObject({ file: "src/stripe.ts", symbol: "stripe" });
  });

  it("queries: observe handler reads, declared run writes (A4004)", () => {
    const q = node<QueryNode>("Query:Team.listInvites");
    expect(q.mode).toBe("observe");
    expect(q.reads).toEqual(["Entity:Invitation"]);
    expect(q.handler).toMatchObject({ file: "src/handlers.ts", symbol: "listInvitationsHandler" });
    expect(node<QueryNode>("Query:Team.stats").reads).toEqual(["Entity:Invitation"]);
  });

  it("the duplicate keeps the first declaration in source order", () => {
    expect(node<ActionNode>("Action:Team.inviteMember").src?.file).toBe("src/averri/actions.ts");
  });

  it("derives generated Test nodes and links hand-written tests", () => {
    const gen = Object.values(graph.nodes).filter((n): n is TestNode => n.kind === "Test" && (n as TestNode).generated);
    expect(gen.map((t) => t.id)).toContain("Test:gen/Team.inviteMember.precondition");
    expect(gen.every((t) => typeof t.sourceHash === "string")).toBe(true);
    const hw = node<TestNode>("Test:tests/teams.spec.ts:6");
    // covers: the `// @averri covers` header plus node-id string literals asserted in the test
    expect(hw.covers).toEqual(["Action:Team.inviteMember", "Policy:Team.OwnerOrAdmin"]);
  });

  it("diagnostics match the golden file", () => {
    const { expected, actual } = matchGolden("team-app.diagnostics", goldenDiagnostics(graph));
    expect(actual).toEqual(expected);
  });

  it("emits every code the fixture exercises", () => {
    const codes = new Set(graph.diagnostics.map((d) => d.code));
    for (const c of [
      "A1001", "A1003", "A1004", "A1005", "A2101", "A2103", "A2104", "A2105", "A2106", "A3001", "A3002", "A3003", "A3005", "A3006", "A3007",
      "A3008", "A3009", "A3010", "A4001", "A4002", "A4003", "A4004", "A4005", "A5001", "A5002", "A6001",
    ]) {
      expect(codes.has(c as never), c).toBe(true);
    }
  });

  it("every diagnostic respects the registry, the fix rule, the budget and sorting", () => {
    let prev = -1;
    const rank = { error: 0, warning: 1, info: 2 } as const;
    graph.diagnostics.forEach((d, i) => {
      expect(diagnosticConsistencyIssues(d), d.code).toEqual([]);
      expect(budgetSize(d)).toBeLessThanOrEqual(DIAGNOSTIC_CHAR_BUDGET);
      expect(d.id).toBe(`D-${String(i + 1).padStart(4, "0")}`);
      expect(rank[d.severity]).toBeGreaterThanOrEqual(prev);
      prev = rank[d.severity];
      for (const f of d.fixes) if (f.patch) expect(f.patch.length).toBeLessThanOrEqual(4000);
    });
  });

  it("every patch fix applies to the working tree (dry run)", () => {
    const patches = graph.diagnostics.flatMap((d) => d.fixes.filter((f) => f.patch).map((f) => ({ code: d.code, patch: f.patch as string })));
    expect(patches.length).toBeGreaterThanOrEqual(8);
    for (const p of patches) {
      expect(patchApplies(p.patch, (f) => (fs.existsSync(path.join(fx.root, f)) ? fs.readFileSync(path.join(fx.root, f), "utf8") : null)), p.code).toBe(true);
    }
  });

  it("health counters", () => {
    expect(graph.meta.health).toMatchObject({
      exposures: 9,
      exposuresUndeclared: 5,
      exposuresWithoutPolicy: 2,
      actionsDeclared: 3,
      actionsObserve: 2,
      queries: 3,
      opaqueGuards: 2,
      eventsWithoutConsumer: 1,
    });
    expect(graph.meta.health.errors).toBe(graph.diagnostics.filter((d) => d.severity === "error").length);
  });
});
