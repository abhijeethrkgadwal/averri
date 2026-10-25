/**
 * Test fixtures: node factories with sensible defaults and a graph builder that fills `meta`
 * (counts computed from the nodes). Mirrors the SPEC-IR §9 worked example.
 */

import {
  GRAPH_SCHEMA_VERSION,
  computeCounts,
  computeHealth,
  type ActionNode,
  type BoolExpr,
  type ContractNode,
  type Diagnostic,
  type Edge,
  type EdgeKind,
  type EntityNode,
  type EventNode,
  type ExposureNode,
  type FieldNode,
  type Graph,
  type GraphMeta,
  type IntegrationNode,
  type ModuleNode,
  type Node,
  type NodeId,
  type PolicyNode,
  type Provenance,
  type QueryNode,
  type TestNode,
  type WorkflowNode,
} from "../src/index.js";

export const declared: Provenance = { origin: "declared", declaredAt: { file: "src/members/inviteMember.ts", range: [[22, 0], [48, 3]] } };
export const extracted = (confidence = 0.98): Provenance => ({
  origin: "extracted",
  extractor: "prisma",
  confidence,
  evidence: [{ kind: "schema", note: "model block" }],
});
export const verified: Provenance = {
  origin: "verified",
  declaredAt: { file: "src/members/inviteMember.ts", range: [[22, 0], [48, 3]] },
  verifiers: ["route-match", "effect-scan"],
  evidence: [{ kind: "call", note: "tx.invitation.upsert at 38:16" }],
};

type Overrides<T> = Partial<Omit<T, "kind">>;

export function entity(model: string, o: Overrides<EntityNode> = {}): EntityNode {
  return {
    id: `Entity:${model}`,
    kind: "Entity",
    name: model,
    summary: `model ${model}`,
    provenance: extracted(0.95),
    src: { file: "prisma/schema.prisma", range: [[1, 0], [10, 1]] },
    model,
    clientName: model.charAt(0).toLowerCase() + model.slice(1),
    fields: [],
    idFields: ["id"],
    uniques: [],
    invariants: [],
    ...o,
  };
}

export function field(model: string, name: string, o: Overrides<FieldNode> = {}): FieldNode {
  return {
    id: `Field:${model}.${name}`,
    kind: "Field",
    name,
    summary: `${model}.${name}`,
    provenance: extracted(0.95),
    src: null,
    entity: `Entity:${model}`,
    type: { kind: "scalar", name: "String", list: false },
    optional: false,
    isId: false,
    unique: false,
    hasDefault: false,
    ...o,
  };
}

export function action(qualifier: string, o: Overrides<ActionNode> = {}): ActionNode {
  return {
    id: `Action:${qualifier}`,
    kind: "Action",
    name: qualifier,
    summary: `action ${qualifier}`,
    provenance: declared,
    src: { file: "src/members/inviteMember.ts", range: [[22, 0], [48, 3]] },
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
    handler: { file: "src/members/inviteMember.ts", symbol: `${qualifier.split(".")[1]}.run` },
    ratios: { opaqueGuards: 0, totalContracts: 0, handlerLines: 0 },
    ...o,
  };
}

export function query(qualifier: string, o: Overrides<QueryNode> = {}): QueryNode {
  return {
    id: `Query:${qualifier}`,
    kind: "Query",
    name: qualifier,
    summary: `query ${qualifier}`,
    provenance: declared,
    src: null,
    mode: "declared",
    route: null,
    input: { zod: null, fields: [] },
    output: { kind: "unknown" },
    policy: null,
    public: false,
    reads: [],
    handler: { file: "src/members/listMembers.ts", symbol: "ListMembers.run" },
    ratios: { handlerLines: 0 },
    ...o,
  };
}

export function policy(qualifier: string, o: Overrides<PolicyNode> = {}): PolicyNode {
  return {
    id: `Policy:${qualifier}`,
    kind: "Policy",
    name: qualifier,
    summary: `policy ${qualifier}`,
    provenance: declared,
    src: null,
    allow: `Contract:${qualifier}.allow`,
    tier: "predicate",
    appliesTo: [],
    ...o,
  };
}

export function contract(id: `Contract:${string}`, of: ContractNode["of"], phase: ContractNode["phase"], expr: BoolExpr | null, o: Overrides<ContractNode> = {}): ContractNode {
  const clause = id.slice(id.lastIndexOf(".") + 1);
  const tier = expr === null ? "guard" : JSON.stringify(expr).includes('"db.') ? "predicate" : "expr";
  return {
    id,
    kind: "Contract",
    name: clause,
    summary: `contract ${clause}`,
    provenance: declared,
    src: null,
    of,
    phase,
    clause: phase === "allow" ? "allow" : clause,
    tier,
    expr,
    opaque: expr === null,
    ...o,
  };
}

export function event(name: string, o: Overrides<EventNode> = {}): EventNode {
  return { id: `Event:${name}`, kind: "Event", name, summary: `event ${name}`, provenance: declared, src: null, payload: { teamId: "string" }, external: false, ...o };
}

export function workflow(name: string, on: `Event:${string}`, o: Overrides<WorkflowNode> = {}): WorkflowNode {
  return { id: `Workflow:${name}`, kind: "Workflow", name, summary: `workflow ${name}`, provenance: declared, src: null, on, engine: "custom", runner: null, retry: null, steps: [], ...o };
}

export function integration(name: string, o: Overrides<IntegrationNode> = {}): IntegrationNode {
  return {
    id: `Integration:${name}`,
    kind: "Integration",
    name,
    summary: `integration ${name}`,
    provenance: declared,
    src: null,
    client: null,
    webhook: null,
    idempotency: null,
    nonTransactional: true,
    ...o,
  };
}

export function exposure(file: string, line: number, col: number, method: ExposureNode["method"], path: string, o: Overrides<ExposureNode> = {}): ExposureNode {
  return {
    id: `Exposure:hono:${file}:${line}:${col}`,
    kind: "Exposure",
    name: `${method} ${path}`,
    summary: `${method} ${path}`,
    provenance: { origin: "extracted", extractor: "hono", confidence: 0.98, evidence: [{ kind: "route", note: "registered" }] },
    src: { file, range: [[line, col], [line, col + 4]] },
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

export function test(id: `Test:${string}`, covers: NodeId[], o: Overrides<TestNode> = {}): TestNode {
  const generated = id.startsWith("Test:gen/");
  return {
    id,
    kind: "Test",
    name: id.slice(5),
    summary: `test ${id.slice(5)}`,
    provenance: { origin: "extracted", extractor: "vitest", confidence: 0.98, evidence: [{ kind: "test", note: "derived" }] },
    src: null,
    generated,
    suite: generated ? "auth-matrix" : "hand-written",
    file: generated ? "tests/averri/team.gen.test.ts" : "tests/members.test.ts",
    title: "t",
    covers,
    lastResult: null,
    ...(generated ? { sourceHash: "abc" } : {}),
    ...o,
  };
}

export function module(file: string, o: Overrides<ModuleNode> = {}): ModuleNode {
  return {
    id: `Module:${file}`,
    kind: "Module",
    name: file,
    summary: `module ${file}`,
    provenance: { origin: "extracted", extractor: "ts-handler", confidence: 1, evidence: [{ kind: "source", note: "read" }] },
    src: null,
    file,
    role: "handler",
    exports: [],
    hash: "h",
    lines: 10,
    ...o,
  };
}

export function edge(kind: EdgeKind, from: NodeId, to: NodeId, provenance: Provenance = declared, attrs?: Edge["attrs"]): Edge {
  return attrs ? { kind, from, to, provenance, attrs } : { kind, from, to, provenance };
}

export function diagnostic(id: `D-${string}`, code: Diagnostic["code"], severity: Diagnostic["severity"], o: Partial<Diagnostic> = {}): Diagnostic {
  return {
    id,
    code,
    severity,
    title: "t",
    node: null,
    path: null,
    src: null,
    cause: [],
    related: [],
    fixes: [],
    since_last_green: null,
    docs: null,
    ...o,
  };
}

export function meta(nodes: Record<string, Node>, o: Partial<GraphMeta> = {}): GraphMeta {
  return {
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
      entryPoints: ["src/index.ts"],
      commands: { build: null, test: "vitest", typecheck: null },
      conventions: [],
    },
    counts: computeCounts(nodes),
    health: computeHealth({ nodes, edges: [], diagnostics: [] }),
    ...o,
  };
}

export function graph(nodeList: Node[], edges: Edge[] = [], diagnostics: Diagnostic[] = [], metaOverrides: Partial<GraphMeta> = {}): Graph {
  const nodes: Record<string, Node> = {};
  for (const n of nodeList) nodes[n.id] = n;
  const m = meta(nodes, metaOverrides);
  m.health = computeHealth({ nodes, edges, diagnostics });
  return { meta: m, nodes: nodes as Graph["nodes"], edges, diagnostics };
}

/** The SPEC-IR §9 worked example, abridged. */
export function exampleGraph(): Graph {
  const invitation = entity("Invitation", { fields: ["Field:Invitation.status", "Field:Invitation.email", "Field:Invitation.acceptedAt"] });
  const membership = entity("Membership", { fields: ["Field:Membership.teamId", "Field:Membership.user"] });
  const user = entity("User", { fields: ["Field:User.email"] });
  const fields = [
    field("Invitation", "status", { type: { kind: "enum", name: "InvitationStatus", values: ["pending", "accepted"], list: false } }),
    field("Invitation", "email"),
    field("Invitation", "acceptedAt", { type: { kind: "scalar", name: "DateTime", list: false }, optional: true }),
    field("Membership", "teamId"),
    field("Membership", "user", { type: { kind: "relation", to: "Entity:User", list: false } }),
    field("User", "email", { unique: true }),
  ];
  const notAlreadyMember: BoolExpr = {
    op: "db.none",
    model: "membership",
    where: { teamId: { ref: "input.teamId" }, "user.email": { ref: "input.email" } },
  };
  const pendingForEmail: BoolExpr = { op: "eq", lhs: { ref: "result.status" }, rhs: { lit: "pending" } };
  const eventEmitted: BoolExpr = { op: "emitted", event: "Event:MemberInvited" };
  const allow: BoolExpr = {
    op: "db.exists",
    model: "membership",
    where: { teamId: { ref: "input.teamId" }, userId: { ref: "actor.id" }, role: { in: { lit: ["owner", "admin"] } } },
  };
  const invariant: BoolExpr = { op: "or", args: [{ op: "ne", lhs: { ref: "self.status" }, rhs: { lit: "pending" } }, { op: "isNull", arg: { ref: "self.acceptedAt" } }] };
  const nodes: Node[] = [
    invitation,
    membership,
    user,
    ...fields,
    action("Team.inviteMember", {
      provenance: verified,
      route: { method: "POST", path: "/teams/:teamId/invitations", exposure: "Exposure:hono:src/routes/teams.ts:41:4", verified: true },
      input: { zod: { file: "src/members/inviteMember.ts", symbol: "InviteMember.input" }, fields: ["teamId", "email", "role"] },
      output: { entity: "Entity:Invitation" },
      policy: "Policy:Team.OwnerOrAdmin",
      subject: null,
      contracts: [
        "Contract:Team.inviteMember.requires.notAlreadyMember",
        "Contract:Team.inviteMember.requires.emailDomainAllowed",
        "Contract:Team.inviteMember.ensures.pendingForEmail",
        "Contract:Team.inviteMember.ensures.eventEmitted",
      ],
      effects: { declared: ["db:write", "event:emit"], verified: { reads: [], writes: ["Entity:Invitation"], emits: ["Event:MemberInvited"], calls: [], complete: true } },
      handler: { file: "src/members/inviteMember.ts", symbol: "InviteMember.run" },
      ratios: { opaqueGuards: 1, totalContracts: 4, handlerLines: 9 },
      intent: "An owner or admin invites a person by email.",
    }),
    query("Team.listMembers", { policy: "Policy:Team.OwnerOrAdmin", reads: ["Entity:Membership"], ratios: { handlerLines: 4 } }),
    policy("Team.OwnerOrAdmin", { appliesTo: ["Action:Team.inviteMember", "Query:Team.listMembers"] }),
    contract("Contract:Team.OwnerOrAdmin.allow", "Policy:Team.OwnerOrAdmin", "allow", allow),
    contract("Contract:Team.inviteMember.requires.notAlreadyMember", "Action:Team.inviteMember", "requires", notAlreadyMember),
    contract("Contract:Team.inviteMember.requires.emailDomainAllowed", "Action:Team.inviteMember", "requires", null),
    contract("Contract:Team.inviteMember.ensures.pendingForEmail", "Action:Team.inviteMember", "ensures", pendingForEmail),
    contract("Contract:Team.inviteMember.ensures.eventEmitted", "Action:Team.inviteMember", "ensures", eventEmitted),
    contract("Contract:Invitation.invariant.pendingHasNoAcceptedAt", "Entity:Invitation", "invariant", invariant),
    event("MemberInvited"),
    event("Orphan"),
    workflow("InviteFlow", "Event:MemberInvited"),
    exposure("src/routes/teams.ts", 41, 4, "POST", "/teams/:teamId/invitations", { boundTo: "Action:Team.inviteMember", middleware: ["auth()"] }),
    exposure("src/routes/teams.ts", 50, 4, "GET", "/teams/:teamId/members", { middleware: ["auth()"] }),
    exposure("src/routes/health.ts", 3, 4, "GET", "/health"),
    test("Test:gen/Team.inviteMember.auth-matrix", ["Action:Team.inviteMember"]),
    test("Test:tests/members.test.ts:17", ["Action:Team.inviteMember"]),
    module("src/members/inviteMember.ts", { role: "declaration", lines: 60 }),
    module("src/routes/teams.ts", { role: "route", lines: 80 }),
    module("prisma/schema.prisma", { role: "prisma-schema", lines: 40 }),
    module("tests/members.test.ts", { role: "test", lines: 120 }),
  ];
  const edges: Edge[] = [
    edge("contains", "Module:src/members/inviteMember.ts", "Action:Team.inviteMember", extracted(1)),
    edge("contains", "Module:src/members/inviteMember.ts", "Policy:Team.OwnerOrAdmin", extracted(1)),
    edge("contains", "Module:src/routes/teams.ts", "Exposure:hono:src/routes/teams.ts:41:4", extracted(1)),
    edge("contains", "Entity:Invitation", "Field:Invitation.status", extracted(0.95)),
    edge("contains", "Entity:Invitation", "Field:Invitation.email", extracted(0.95)),
    edge("contains", "Entity:Invitation", "Field:Invitation.acceptedAt", extracted(0.95)),
    edge("contains", "Entity:Membership", "Field:Membership.teamId", extracted(0.95)),
    edge("contains", "Entity:Membership", "Field:Membership.user", extracted(0.95)),
    edge("contains", "Entity:User", "Field:User.email", extracted(0.95)),
    edge("persistedBy", "Entity:Invitation", "Module:prisma/schema.prisma", extracted(0.95)),
    edge("persistedBy", "Entity:Membership", "Module:prisma/schema.prisma", extracted(0.95)),
    edge("persistedBy", "Entity:User", "Module:prisma/schema.prisma", extracted(0.95)),
    edge("constrains", "Contract:Team.inviteMember.requires.notAlreadyMember", "Action:Team.inviteMember"),
    edge("constrains", "Contract:Team.inviteMember.requires.emailDomainAllowed", "Action:Team.inviteMember"),
    edge("constrains", "Contract:Team.inviteMember.ensures.pendingForEmail", "Action:Team.inviteMember"),
    edge("constrains", "Contract:Team.inviteMember.ensures.eventEmitted", "Action:Team.inviteMember"),
    edge("constrains", "Contract:Team.OwnerOrAdmin.allow", "Policy:Team.OwnerOrAdmin"),
    edge("constrains", "Contract:Invitation.invariant.pendingHasNoAcceptedAt", "Entity:Invitation"),
    edge("authorizes", "Policy:Team.OwnerOrAdmin", "Action:Team.inviteMember"),
    edge("authorizes", "Policy:Team.OwnerOrAdmin", "Query:Team.listMembers"),
    edge("exposes", "Exposure:hono:src/routes/teams.ts:41:4", "Action:Team.inviteMember", verified),
    edge("returns", "Action:Team.inviteMember", "Entity:Invitation"),
    edge("writes", "Action:Team.inviteMember", "Entity:Invitation", verified),
    edge("reads", "Contract:Team.inviteMember.requires.notAlreadyMember", "Entity:Membership"),
    edge("reads", "Policy:Team.OwnerOrAdmin", "Entity:Membership"),
    edge("reads", "Query:Team.listMembers", "Entity:Membership", verified),
    edge("emits", "Action:Team.inviteMember", "Event:MemberInvited", verified),
    edge("consumedBy", "Event:MemberInvited", "Workflow:InviteFlow"),
    edge("implementedBy", "Action:Team.inviteMember", "Module:src/members/inviteMember.ts", verified, { symbol: "InviteMember.run" }),
    edge("validatesWith", "Action:Team.inviteMember", "Module:src/members/inviteMember.ts", verified, { symbol: "InviteMember.input" }),
    edge("verifiedBy", "Action:Team.inviteMember", "Test:gen/Team.inviteMember.auth-matrix"),
    edge("verifiedBy", "Action:Team.inviteMember", "Test:tests/members.test.ts:17", verified),
  ];
  const diagnostics: Diagnostic[] = [
    diagnostic("D-0001", "A2103", "warning", { node: "Exposure:hono:src/routes/health.ts:3:4", path: "src/routes/health.ts:3", docs: "averri://docs/policy" }),
    diagnostic("D-0002", "A2104", "warning", { node: "Exposure:hono:src/routes/teams.ts:50:4", path: "src/routes/teams.ts:50", docs: "averri://docs/action" }),
    diagnostic("D-0003", "A4003", "warning", { node: "Event:Orphan", docs: "averri://docs/event" }),
  ];
  return graph(nodes, edges, diagnostics, { commit: "abc123", contentHash: "hash-base" });
}

/** Deep clone through JSON (graphs are JSON-safe). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
