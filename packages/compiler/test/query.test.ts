/**
 * Graph queries behind the MCP/CLI tools: overview, find, inspect (budgets, drill-down handles,
 * low-confidence refusal), spec cards, OpenAPI, and explain over recorded traces.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExposureNode, Graph } from "@averri/ir";
import { build } from "../src/build.js";
import { renderCardMarkdown, specCard } from "../src/cards.js";
import { explain } from "../src/explain.js";
import { toOpenApi } from "../src/openapi.js";
import { find } from "../src/query/find.js";
import { inspect } from "../src/query/inspect.js";
import { overview } from "../src/query/overview.js";
import { BUILD_TIMEOUT, copyFixture, type FixtureCopy } from "./helpers.js";

let fx: FixtureCopy;
let graph: Graph;
const tokens = (v: unknown): number => Math.ceil(JSON.stringify(v).length / 4);

beforeAll(() => {
  fx = copyFixture("team-app");
  graph = build(fx.root, { writeCache: false, git: false }).graph;
}, BUILD_TIMEOUT);

afterAll(() => fx?.cleanup());

describe("overview", () => {
  it("fits 1 200 tokens and carries the informational ratio note", () => {
    const r = overview(graph);
    expect(tokens(r.data)).toBeLessThanOrEqual(1200);
    expect(r.data.health.handlerLineRatioNote).toBe("informational in V0");
    expect(r.data.topModules[0]).toMatchObject({ file: "src/averri/actions.ts" });
    expect(r.data.quickstart.split("\n")).toHaveLength(5);
  });
});

describe("find", () => {
  it("ranks exact id, then qualifier prefix, then substring, then token overlap", () => {
    const exact = find(graph, { query: "Action:Team.inviteMember" });
    expect(exact.data.hits[0]?.id).toBe("Action:Team.inviteMember");
    const prefix = find(graph, { query: "Team.invite" });
    expect(prefix.data.hits[0]?.id).toBe("Action:Team.inviteMember");
    const route = find(graph, { query: "/webhooks/stripe" });
    expect(route.data.hits.map((h) => h.kind)).toContain("Exposure");
    const tokensQ = find(graph, { query: "invite member email" });
    expect(tokensQ.data.hits.length).toBeGreaterThan(0);
    const kinds = find(graph, { query: "invitation", kind: "Entity" });
    expect(kinds.data.hits.every((h) => h.kind === "Entity")).toBe(true);
    expect(exact.data.hits[0]?.path).toBe("src/averri/actions.ts:12");
    expect(exact.data.hits[0]?.origin).toBe("verified");
  });

  it("stays within 800 tokens, dropping hits from the end into `more`", () => {
    const r = find(graph, { query: "a", limit: 30 });
    expect(tokens(r.data)).toBeLessThanOrEqual(800);
    if (r.truncated) expect((r.more ?? []).length + r.data.hits.length).toBeGreaterThan(0);
  });
});

describe("inspect", () => {
  it("returns node, card, grouped edges (both directions), dependents and diagnostics", () => {
    const r = inspect(graph, { id: "Team.inviteMember", include: ["tests", "source"] }, { root: fx.root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.node.id).toBe("Action:Team.inviteMember");
    expect(r.data.edges.authorizes).toEqual(["Policy:Team.OwnerOrAdmin"]);
    expect(r.data.edges.writes).toEqual(["Entity:Invitation"]);
    expect(r.data.card.preconditions[0]).toMatchObject({ clause: "notAlreadyMember", tier: "predicate" });
    expect(r.data.card.whoMay).toContain("membership exists where teamId = input.teamId");
    expect(r.data.tests?.some((t) => t.suite === "auth-matrix")).toBe(true);
    expect(tokens(r.data)).toBeLessThanOrEqual(2000);
  });

  it("reports diagnostics open on the node and refuses unknown ids", () => {
    const r = inspect(graph, { id: "Action:Team.remove" }, { root: fx.root });
    expect(r.ok && r.data.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["A2101", "A4005", "A4001"]));
    expect(inspect(graph, { id: "Nope" }).ok).toBe(false);
  });

  it("refuses a low-confidence target with low-confidence + candidates", () => {
    const g = structuredClone(graph);
    const x = g.nodes["Exposure:hono:src/app.ts:12:4" as never] as ExposureNode;
    x.provenance = { origin: "extracted", extractor: "hono", confidence: 0.5, evidence: [{ kind: "route", note: "router never reached from an entry point" }] };
    const r = inspect(g, { id: x.id });
    expect(r).toMatchObject({ ok: false, error: "low-confidence", candidates: [x.id] });
  });
});

describe("spec cards and OpenAPI", () => {
  it("renders the Markdown card in <= 15 lines with intent, who-may, clauses, effects", () => {
    const md = renderCardMarkdown(graph, "Action:Team.inviteMember") as string;
    const lines = md.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(15);
    expect(lines[0]).toBe("## Team.inviteMember — POST /teams/:teamId/invitations");
    expect(md).toContain("Intent: An owner or admin invites a person by email.");
    expect(md).toContain("  - notAlreadyMember: no membership where teamId = input.teamId, user.email = input.email   [verified]");
    expect(md).toContain('  - pendingForEmail: result.email = input.email and result.status = "pending"   [verified]');
    expect(md).toContain("  - eventEmitted: MemberInvited emitted exactly 1   [verified]");
    expect(md).toContain("Effects: writes Invitation, reads Membership (policy, requires), emits MemberInvited → InviteFlow");
    const card = specCard(graph, "Entity:Invitation");
    expect(card?.invariants.map((i) => i.clause)).toEqual(["pendingHasNoAcceptedAt", "seatsPositive"]);
  });

  it("derives an OpenAPI 3.1 document from routed declarations", () => {
    const doc = toOpenApi(graph);
    const op = doc.paths["/teams/{teamId}/invitations"]?.post as { operationId: string; parameters: Array<{ name: string }>; requestBody: unknown; responses: Record<string, unknown> };
    expect(op.operationId).toBe("Team.inviteMember");
    expect(op.parameters.map((p) => p.name)).toEqual(["teamId"]);
    expect(op.responses).toHaveProperty("412");
    expect(op.responses).toHaveProperty("403");
    expect(doc.components.schemas.Invitation).toMatchObject({ type: "object" });
    const health = doc.paths["/health"]?.get as { "x-averri": { undeclared: boolean } };
    expect(health["x-averri"].undeclared).toBe(true);
  });
});

describe("explain {traceId}", () => {
  it("returns actual vs expected, the pasteable input, and the chain", () => {
    const dir = path.join(fx.root, ".averri/traces");
    fs.mkdirSync(dir, { recursive: true });
    const trace = {
      traceId: "tr_1",
      action: "Action:Team.inviteMember",
      mode: "declared",
      startedAt: "2026-10-25T10:00:00.000Z",
      durationMs: 12,
      actor: { id: "u_owner", summary: "owner#u_owner" },
      phases: [
        { phase: "validate", ok: true },
        { phase: "authorize", ok: true, policy: "Policy:Team.OwnerOrAdmin", decision: "allow", observed: false },
        {
          phase: "requires",
          ok: false,
          contract: "Contract:Team.inviteMember.requires.notAlreadyMember",
          tier: "predicate",
          evaluated: { "": { lhs: 1, rhs: 0 } },
          durationMs: 3,
        },
      ],
      outcome: { ok: false, phase: "requires", contract: "Contract:Team.inviteMember.requires.notAlreadyMember", message: "precondition failed", committed: false },
      request: { method: "POST", path: "/teams/t1/invitations", body: { email: "a@b.c", role: "member" }, headers: {} },
      test: { file: "tests/averri/Team.inviteMember.gen.test.ts", title: "[Test:gen/Team.inviteMember.precondition] Team.inviteMember > satisfying input is accepted" },
    };
    fs.writeFileSync(path.join(dir, "2026-10-25.123.jsonl"), `${JSON.stringify(trace)}\n{ partial`);
    const r = explain(graph, { traceId: "tr_1", detail: "full" }, { root: fx.root, blame: false, lastGreen: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.failure).toEqual({
      assertion: "Contract:Team.inviteMember.requires.notAlreadyMember: no membership where teamId = input.teamId, user.email = input.email",
      actual: { "(root)": 1 },
      expected: { "(root)": 0 },
    });
    expect(r.data.triggeringInput).toEqual({ method: "POST", path: "/teams/t1/invitations", body: { email: "a@b.c", role: "member" }, actor: { fixture: "owner", id: "u_owner" } });
    expect(r.data.chain.map((c) => c.role)).toEqual(["exposure", "route", "policy", "contract", "handler", "event", "workflow", "test"]);
    expect(r.data.declaration).toEqual({ contract: "Contract:Team.inviteMember.requires.notAlreadyMember", path: "src/averri/actions.ts:19", author: null });
    expect(r.data.trace?.traceId).toBe("tr_1");
    expect(r.data.rerun).toContain("-t");
    expect(explain(graph, { traceId: "nope" }, { root: fx.root }).ok).toBe(false);
    expect(explain(graph, {}, { root: fx.root })).toMatchObject({ ok: false, error: "bad-input" });
  });

  it("explain {diag: {code, node}} resolves against the current graph", () => {
    const r = explain(graph, { diag: { code: "A2101", node: "Team.remove" } }, { root: fx.root, blame: false, lastGreen: null });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.subject.kind).toBe("diagnostic");
      expect(r.data.chain.map((c) => c.node)).toContain("Exposure:hono:src/routes/teams.ts:18:11");
      expect(String(r.data.failure?.expected)).toContain("Use the registered path");
    }
  });
});
