/**
 * A graph mirroring the SPEC-DECLARATIONS worked example plus the shapes the generator must handle:
 * declared and observe modes, tier-1/2/3 requires, a subject, an entity invariant, an event with a
 * workflow, and two webhook integrations. Built with local factories (no cross-package test imports).
 */

import {
  GRAPH_SCHEMA_VERSION,
  computeCounts,
  computeHealth,
  type ActionNode,
  type BoolExpr,
  type ContractNode,
  type Edge,
  type EdgeKind,
  type EntityNode,
  type EventNode,
  type ExposureNode,
  type FieldNode,
  type FieldType,
  type Graph,
  type IntegrationNode,
  type Node,
  type NodeId,
  type PolicyNode,
  type PrismaScalar,
  type Provenance,
  type QueryNode,
  type WorkflowNode,
} from "@averri/ir";

const declaredAt = (file: string): Provenance => ({ origin: "declared", declaredAt: { file, range: [[1, 0], [10, 1]] } });
const extracted: Provenance = { origin: "extracted", extractor: "prisma", confidence: 0.95, evidence: [{ kind: "schema", note: "model block" }] };

type O<T> = Partial<Omit<T, "kind">>;

export function entity(model: string, fieldNames: string[], o: O<EntityNode> = {}): EntityNode {
  return {
    id: `Entity:${model}`,
    kind: "Entity",
    name: model,
    summary: `model ${model}`,
    provenance: extracted,
    src: { file: "prisma/schema.prisma", range: [[1, 0], [10, 1]] },
    model,
    clientName: model.charAt(0).toLowerCase() + model.slice(1),
    fields: fieldNames.map((f) => `Field:${model}.${f}` as const),
    idFields: ["id"],
    uniques: [],
    invariants: [],
    ...o,
  };
}

const scalar = (name: PrismaScalar, list = false): FieldType => ({ kind: "scalar", name, list });

export function field(model: string, name: string, type: FieldType = scalar("String"), o: O<FieldNode> = {}): FieldNode {
  return {
    id: `Field:${model}.${name}`,
    kind: "Field",
    name,
    summary: `${model}.${name}`,
    provenance: extracted,
    src: null,
    entity: `Entity:${model}`,
    type,
    optional: false,
    isId: false,
    unique: false,
    hasDefault: false,
    ...o,
  };
}

export function action(qualifier: string, file: string, o: O<ActionNode> = {}): ActionNode {
  return {
    id: `Action:${qualifier}`,
    kind: "Action",
    name: qualifier,
    summary: `action ${qualifier}`,
    provenance: declaredAt(file),
    src: { file, range: [[1, 0], [10, 1]] },
    mode: "declared",
    route: null,
    input: { zod: null, fields: [] },
    output: { kind: "void" },
    policy: null,
    public: false,
    subject: null,
    contracts: [],
    effects: { declared: [], verified: { reads: [], writes: [], emits: [], calls: [], complete: true } },
    transaction: true,
    idempotency: null,
    handler: null,
    ratios: { opaqueGuards: 0, totalContracts: 0, handlerLines: 0 },
    ...o,
  };
}

export function query(qualifier: string, file: string, o: O<QueryNode> = {}): QueryNode {
  return {
    id: `Query:${qualifier}`,
    kind: "Query",
    name: qualifier,
    summary: `query ${qualifier}`,
    provenance: declaredAt(file),
    src: { file, range: [[1, 0], [10, 1]] },
    mode: "declared",
    route: null,
    input: { zod: null, fields: [] },
    output: { kind: "unknown" },
    policy: null,
    public: false,
    reads: [],
    handler: null,
    ratios: { handlerLines: 0 },
    ...o,
  };
}

export function policy(qualifier: string, file: string, tier: PolicyNode["tier"] = "predicate", o: O<PolicyNode> = {}): PolicyNode {
  return {
    id: `Policy:${qualifier}`,
    kind: "Policy",
    name: qualifier,
    summary: `policy ${qualifier}`,
    provenance: declaredAt(file),
    src: { file, range: [[1, 0], [10, 1]] },
    allow: `Contract:${qualifier}.allow`,
    tier,
    appliesTo: [],
    ...o,
  };
}

export function contract(id: `Contract:${string}`, of: ContractNode["of"], phase: ContractNode["phase"], expr: BoolExpr | null, file = "src/decl.ts"): ContractNode {
  const clause = phase === "allow" ? "allow" : id.slice(id.lastIndexOf(".") + 1);
  const tier: ContractNode["tier"] = expr === null ? "guard" : JSON.stringify(expr).includes('"db.') ? "predicate" : "expr";
  return { id, kind: "Contract", name: clause, summary: `contract ${clause}`, provenance: declaredAt(file), src: null, of, phase, clause, tier, expr, opaque: expr === null };
}

export function event(name: string, file: string, o: O<EventNode> = {}): EventNode {
  return { id: `Event:${name}`, kind: "Event", name, summary: `event ${name}`, provenance: declaredAt(file), src: null, payload: { teamId: "string" }, external: false, ...o };
}

export function workflow(name: string, on: `Event:${string}`, file: string, o: O<WorkflowNode> = {}): WorkflowNode {
  return { id: `Workflow:${name}`, kind: "Workflow", name, summary: `workflow ${name}`, provenance: declaredAt(file), src: null, on, engine: "inngest", runner: null, retry: null, steps: [], ...o };
}

export function integration(name: string, file: string, o: O<IntegrationNode> = {}): IntegrationNode {
  return { id: `Integration:${name}`, kind: "Integration", name, summary: `integration ${name}`, provenance: declaredAt(file), src: null, client: null, webhook: null, idempotency: null, nonTransactional: true, ...o };
}

export function exposure(file: string, line: number, method: ExposureNode["method"], path: string, o: O<ExposureNode> = {}): ExposureNode {
  return {
    id: `Exposure:hono:${file}:${line}:4`,
    kind: "Exposure",
    name: `${method} ${path}`,
    summary: `${method} ${path}`,
    provenance: { origin: "extracted", extractor: "hono", confidence: 0.98, evidence: [{ kind: "route", note: "registered" }] },
    src: { file, range: [[line, 4], [line, 8]] },
    router: "hono",
    method,
    path,
    handler: null,
    middleware: [],
    boundTo: null,
    bodySchema: null,
    dynamic: false,
    public: false,
    ...o,
  };
}

export function edge(kind: EdgeKind, from: NodeId, to: NodeId): Edge {
  return { kind, from, to, provenance: extracted };
}

export function graphOf(nodeList: Node[], edges: Edge[] = []): Graph {
  const nodes: Record<string, Node> = {};
  for (const n of nodeList) nodes[n.id] = n;
  const g: Graph = {
    meta: {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      averriVersion: "0.0.1",
      builtAt: "2026-10-24T00:00:00.000Z",
      commit: null,
      dirty: false,
      contentHash: "content",
      root: "/repo",
      stack: {
        orm: "prisma",
        prismaSchema: "prisma/schema.prisma",
        routers: ["hono"],
        validator: "zod",
        testRunner: "vitest",
        packageManager: "npm",
        entryPoints: ["src/app.ts"],
        commands: { build: null, test: "vitest", typecheck: null },
        conventions: [],
      },
      counts: computeCounts(nodes),
      health: computeHealth({ nodes, edges, diagnostics: [] }),
    },
    nodes: nodes as Graph["nodes"],
    edges,
    diagnostics: [],
  };
  return g;
}

// ---------------------------------------------------------------------------
// The reference graph
// ---------------------------------------------------------------------------

export const DECL = "src/members/inviteMember.ts";
export const TEAM_DECL = "src/teams/team.ts";
export const STRIPE_DECL = "src/billing/stripe.ts";

export const notAlreadyMember: BoolExpr = { op: "db.none", model: "membership", where: { teamId: { ref: "input.teamId" }, "user.email": { ref: "input.email" } } };
export const pendingForEmail: BoolExpr = {
  op: "and",
  args: [
    { op: "eq", lhs: { ref: "result.email" }, rhs: { ref: "input.email" } },
    { op: "eq", lhs: { ref: "result.status" }, rhs: { lit: "pending" } },
  ],
};
export const eventEmitted: BoolExpr = { op: "emitted", event: "Event:MemberInvited", count: 1 };
export const ownerOrAdmin: BoolExpr = {
  op: "db.exists",
  model: "membership",
  where: { teamId: { ref: "input.teamId" }, userId: { ref: "actor.id" }, role: { in: { lit: ["owner", "admin"] } } },
};
export const invariantExpr: BoolExpr = { op: "or", args: [{ op: "ne", lhs: { ref: "self.status" }, rhs: { lit: "pending" } }, { op: "isNull", arg: { ref: "self.acceptedAt" } }] };
export const seatsPositive: BoolExpr = { op: "and", args: [{ op: "gte", lhs: { ref: "input.seats" }, rhs: { lit: 1 } }, { op: "lte", lhs: { ref: "input.seats" }, rhs: { lit: 500 } }] };
export const planKnown: BoolExpr = { op: "in", lhs: { ref: "input.plan" }, rhs: { lit: ["free", "pro"] } };
export const teamActive: BoolExpr = { op: "eq", lhs: { ref: "self.status" }, rhs: { lit: "active" } };
export const nameNotEmpty: BoolExpr = { op: "gt", lhs: { op: "len", arg: { ref: "input.name" } }, rhs: { lit: 0 } };
export const actorIsAdmin: BoolExpr = { op: "eq", lhs: { ref: "actor.role" }, rhs: { lit: "admin" } };
export const renamed: BoolExpr = { op: "eq", lhs: { ref: "result.name" }, rhs: { ref: "input.name" } };

export function referenceGraph(): Graph {
  const nodes: Node[] = [
    // --- schema facts ---
    entity("Team", ["id", "name", "status", "seats", "members", "invitations"], { uniques: [["name"]] }),
    field("Team", "id", scalar("String"), { isId: true, hasDefault: true, unique: true }),
    field("Team", "name", scalar("String"), { unique: true }),
    field("Team", "status", { kind: "enum", name: "TeamStatus", values: ["active", "suspended"], list: false }, { hasDefault: true }),
    field("Team", "seats", scalar("Int")),
    field("Team", "members", { kind: "relation", to: "Entity:Membership", list: true }),
    field("Team", "invitations", { kind: "relation", to: "Entity:Invitation", list: true }),
    entity("User", ["id", "email", "name", "createdAt", "memberships"]),
    field("User", "id", scalar("String"), { isId: true, hasDefault: true, unique: true }),
    field("User", "email", scalar("String"), { unique: true }),
    field("User", "name", scalar("String"), { optional: true }),
    field("User", "createdAt", scalar("DateTime"), { hasDefault: true }),
    field("User", "memberships", { kind: "relation", to: "Entity:Membership", list: true }),
    entity("Membership", ["id", "teamId", "team", "userId", "user", "role", "joinedAt"], { uniques: [["teamId", "userId"]] }),
    field("Membership", "id", scalar("String"), { isId: true, hasDefault: true, unique: true }),
    field("Membership", "teamId", scalar("String")),
    field("Membership", "team", { kind: "relation", to: "Entity:Team", list: false }),
    field("Membership", "userId", scalar("String")),
    field("Membership", "user", { kind: "relation", to: "Entity:User", list: false }),
    field("Membership", "role", { kind: "enum", name: "Role", values: ["owner", "admin", "member"], list: false }),
    field("Membership", "joinedAt", scalar("DateTime")),
    entity("Invitation", ["id", "teamId", "team", "email", "role", "status", "acceptedAt", "invitedBy"], {
      uniques: [["teamId", "email"]],
      invariants: ["Contract:Invitation.invariant.pendingHasNoAcceptedAt"],
      provenance: declaredAt(DECL),
    }),
    field("Invitation", "id", scalar("String"), { isId: true, hasDefault: true, unique: true }),
    field("Invitation", "teamId", scalar("String")),
    field("Invitation", "team", { kind: "relation", to: "Entity:Team", list: false }),
    field("Invitation", "email", scalar("String")),
    field("Invitation", "role", { kind: "enum", name: "Role", values: ["owner", "admin", "member"], list: false }),
    field("Invitation", "status", { kind: "enum", name: "InvitationStatus", values: ["pending", "accepted"], list: false }, { hasDefault: true }),
    field("Invitation", "acceptedAt", scalar("DateTime"), { optional: true }),
    field("Invitation", "invitedBy", scalar("String")),
    // --- declarations ---
    policy("Team.OwnerOrAdmin", DECL, "predicate", { appliesTo: ["Action:Team.inviteMember", "Query:Team.listMembers"] }),
    contract("Contract:Team.OwnerOrAdmin.allow", "Policy:Team.OwnerOrAdmin", "allow", ownerOrAdmin, DECL),
    policy("Team.AdminOnly", TEAM_DECL, "expr", { appliesTo: ["Action:Team.rename"] }),
    contract("Contract:Team.AdminOnly.allow", "Policy:Team.AdminOnly", "allow", actorIsAdmin, TEAM_DECL),
    policy("Team.Legacy", TEAM_DECL, "guard", { appliesTo: ["Action:Team.archive"] }),
    contract("Contract:Team.Legacy.allow", "Policy:Team.Legacy", "allow", null, TEAM_DECL),
    action("Team.inviteMember", DECL, {
      provenance: { origin: "verified", declaredAt: { file: DECL, range: [[22, 0], [48, 3]] }, verifiers: ["route-match", "effect-scan"], evidence: [] },
      route: { method: "POST", path: "/teams/:teamId/invitations", exposure: "Exposure:hono:src/routes/teams.ts:41:4", verified: true },
      input: { zod: { file: DECL, symbol: "InviteMember.input" }, fields: ["teamId", "email", "role"] },
      output: { entity: "Entity:Invitation" },
      policy: "Policy:Team.OwnerOrAdmin",
      contracts: [
        "Contract:Team.inviteMember.requires.notAlreadyMember",
        "Contract:Team.inviteMember.requires.emailDomainAllowed",
        "Contract:Team.inviteMember.ensures.pendingForEmail",
        "Contract:Team.inviteMember.ensures.eventEmitted",
      ],
      effects: { declared: ["db:write", "event:emit"], verified: { reads: [], writes: ["Entity:Invitation"], emits: ["Event:MemberInvited"], calls: [], complete: true } },
      idempotency: { key: { header: "Idempotency-Key" }, ttlSeconds: 3600 },
      handler: { file: DECL, symbol: "InviteMember.run" },
      ratios: { opaqueGuards: 1, totalContracts: 4, handlerLines: 9 },
      intent: "An owner or admin invites a person by email.",
    }),
    contract("Contract:Team.inviteMember.requires.notAlreadyMember", "Action:Team.inviteMember", "requires", notAlreadyMember, DECL),
    contract("Contract:Team.inviteMember.requires.emailDomainAllowed", "Action:Team.inviteMember", "requires", null, DECL),
    contract("Contract:Team.inviteMember.ensures.pendingForEmail", "Action:Team.inviteMember", "ensures", pendingForEmail, DECL),
    contract("Contract:Team.inviteMember.ensures.eventEmitted", "Action:Team.inviteMember", "ensures", eventEmitted, DECL),
    action("Team.rename", TEAM_DECL, {
      mode: "observe",
      route: { method: "PATCH", path: "/teams/:teamId", exposure: "Exposure:hono:src/routes/teams.ts:60:4", verified: true },
      input: { zod: { file: TEAM_DECL, symbol: "RenameTeam.input" }, fields: ["teamId", "name", "seats", "plan"] },
      output: { entity: "Entity:Team" },
      policy: "Policy:Team.AdminOnly",
      subject: { entity: "Entity:Team", where: { id: { ref: "input.teamId" } } },
      contracts: [
        "Contract:Team.rename.requires.seatsPositive",
        "Contract:Team.rename.requires.planKnown",
        "Contract:Team.rename.requires.teamActive",
        "Contract:Team.rename.requires.nameNotEmpty",
        "Contract:Team.rename.ensures.renamed",
      ],
      effects: { declared: ["db:write"], verified: { reads: [], writes: ["Entity:Team"], emits: [], calls: [], complete: false } },
      transaction: false,
      ratios: { opaqueGuards: 0, totalContracts: 5, handlerLines: 0 },
    }),
    contract("Contract:Team.rename.requires.seatsPositive", "Action:Team.rename", "requires", seatsPositive, TEAM_DECL),
    contract("Contract:Team.rename.requires.planKnown", "Action:Team.rename", "requires", planKnown, TEAM_DECL),
    contract("Contract:Team.rename.requires.teamActive", "Action:Team.rename", "requires", teamActive, TEAM_DECL),
    contract("Contract:Team.rename.requires.nameNotEmpty", "Action:Team.rename", "requires", nameNotEmpty, TEAM_DECL),
    contract("Contract:Team.rename.ensures.renamed", "Action:Team.rename", "ensures", renamed, TEAM_DECL),
    action("Team.archive", TEAM_DECL, {
      input: { zod: null, fields: ["teamId"] },
      policy: "Policy:Team.Legacy",
      effects: { declared: ["db:write"], verified: { reads: [], writes: ["Entity:Team"], emits: [], calls: [], complete: true } },
    }),
    action("Health.ping", "src/health.ts", { public: true, input: { zod: null, fields: [] }, contracts: ["Contract:Health.ping.ensures.pong"] }),
    contract("Contract:Health.ping.ensures.pong", "Action:Health.ping", "ensures", { op: "eq", lhs: { ref: "result.ok" }, rhs: { lit: true } }, "src/health.ts"),
    query("Team.listMembers", DECL, { policy: "Policy:Team.OwnerOrAdmin", input: { zod: null, fields: ["teamId"] }, reads: ["Entity:Membership"] }),
    contract("Contract:Invitation.invariant.pendingHasNoAcceptedAt", "Entity:Invitation", "invariant", invariantExpr, DECL),
    event("MemberInvited", DECL, { payload: { invitationId: "string", teamId: "string", email: "string" } }),
    event("Orphan", DECL),
    workflow("InviteFlow", "Event:MemberInvited", "src/members/inviteFlow.ts", { retry: { attempts: 3 } }),
    integration("Stripe", STRIPE_DECL, {
      webhook: { verify: "stripe-signature", scheme: "stripe", secretEnv: "STRIPE_WEBHOOK_SECRET", rawBody: true, exposure: "Exposure:hono:src/routes/webhooks.ts:12:4" },
      idempotency: { key: { header: "stripe-signature" }, ttlSeconds: 86400 },
    }),
    integration("Github", "src/integrations/github.ts", {
      webhook: { verify: "x-hub-signature-256", scheme: "hmac-sha256", secretEnv: "GITHUB_WEBHOOK_SECRET", rawBody: false, exposure: "Exposure:hono:src/routes/webhooks.ts:30:4" },
    }),
    integration("Legacy", "src/integrations/legacy.ts", {
      webhook: { verify: "x-legacy-sig", scheme: "custom", secretEnv: null, rawBody: true, exposure: "Exposure:hono:src/routes/webhooks.ts:50:4" },
    }),
    integration("Unresolved", "src/integrations/unresolved.ts", {
      webhook: { verify: "x-sig", scheme: "hmac-sha256", secretEnv: "X_SECRET", rawBody: false, exposure: null },
    }),
    exposure("src/routes/teams.ts", 41, "POST", "/teams/:teamId/invitations", { boundTo: "Action:Team.inviteMember" }),
    exposure("src/routes/teams.ts", 60, "PATCH", "/teams/:teamId", { boundTo: "Action:Team.rename" }),
    exposure("src/routes/webhooks.ts", 12, "POST", "/webhooks/stripe"),
    exposure("src/routes/webhooks.ts", 30, "POST", "/webhooks/github"),
    exposure("src/routes/webhooks.ts", 50, "POST", "/webhooks/legacy"),
  ];
  const edges: Edge[] = [
    edge("authorizes", "Policy:Team.OwnerOrAdmin", "Action:Team.inviteMember"),
    edge("authorizes", "Policy:Team.OwnerOrAdmin", "Query:Team.listMembers"),
    edge("writes", "Action:Team.inviteMember", "Entity:Invitation"),
    edge("writes", "Action:Team.rename", "Entity:Team"),
    edge("emits", "Action:Team.inviteMember", "Event:MemberInvited"),
    edge("consumedBy", "Event:MemberInvited", "Workflow:InviteFlow"),
    edge("constrains", "Contract:Invitation.invariant.pendingHasNoAcceptedAt", "Entity:Invitation"),
  ];
  return graphOf(nodes, edges);
}
