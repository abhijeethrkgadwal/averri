/**
 * Construct documentation served as MCP resources `averri://docs/<name>` (SPEC-MCP §7). Condensed from
 * docs/SPEC-DECLARATIONS.md, SPEC-CONTRACTS.md, SPEC-IR.md and SPEC-DIAGNOSTICS.md. Budgets: `core`
 * <= 1 500 tokens, every other card <= 300 tokens (`ceil(chars / 4)`).
 */

export const DOC_BUDGETS = { core: 1500, other: 300 } as const;

const core = `# Averri core card
Averri is a contract and semantic-graph layer for TypeScript backends (Prisma + Hono/Express + Zod). Nothing runs in the request path in observe mode.

Constructs: entity, policy, action, query, event, workflow, integration. Builders: e (expressions), db (predicates). One spelling each.

Observe mode (the adoption path; no run, route required, handler optional, no transaction):
\`\`\`ts
export const InviteMember = action("Team.inviteMember", {
  intent: "An owner or admin invites a person by email.",
  route: { method: "POST", path: "/teams/:teamId/invitations" },
  input: z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) }),
  output: "Invitation",
  policy: OwnerOrAdmin,
  requires: { notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }) },
  ensures: {
    pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
    eventEmitted: e.emitted(MemberInvited, 1),
  },
  effects: ["db:write", "event:emit"],
});
\`\`\`
Declared mode adds run(ctx) (and optionally subject, transaction); see averri://docs/action.

Reference roots by phase (root.path, 1-3 segments):
- input: requires, ensures, policy allow
- actor: requires, ensures, policy allow
- self: requires, ensures, invariant (needs subject)
- old: ensures only (needs subject)
- result: ensures only
Using a root outside its phase is A3003.

Left side of a comparison is a path string ("result.email"); the right side is e.<root>("field") or a literal. A ref-shaped string on the right is a type error and A3007.

Tiers: e.* = expression (tier 1), db.* = predicate (tier 2), bare async function = guard (tier 3, opaque, no generated tests). Prefer e.*/db.*.

effects values: "db:read", "db:write", "event:emit", "network".
PayloadType values: "string", "number", "boolean", "date", "json".
Ids: Action/Query/Policy are "<Scope>.<name>"; entity, event, workflow and integration are PascalCase. Clause names are camelCase and never start with $.

Docs: averri://docs/<entity|policy|action|query|event|workflow|integration|contracts|identity|tests|graph|check|config>. Spec cards: averri://card/<NodeId>.
`;

export const DOCS: Readonly<Record<string, string>> = {
  core,
  entity: `# entity(name, options?)
Attaches facts to an existing Prisma model; the name MUST equal the model (A1003). The client accessor is Uncapitalize(name), never declared.
- invariant: tier-1 clauses only; a bare path means the row ("status").
- Declared mode checks invariants on the reloaded subject and on result when output is this entity. Observe mode diffs findMany before and after in the test database.
- No model option, no tenantKey: tenant scoping is an ordinary policy predicate.
- Generated test: invariant property test.`,
  policy: `# policy(id, options)
One allow clause over input and actor only. Id: "<Scope>.<name>".
- Evaluated in authorize: after validation, before the transaction, plain client.
- actor null never reaches the policy: non-public declarations answer 401 first.
- Denial is 403 with contract Policy:<id>.
- A guard-tier allow is legal but the auth matrix for its actions is not derivable (A2106, "who may: opaque").
- Exactly one of policy or public: true per action/query.`,
  action: `# action(id, options)
A state-changing operation. Exactly one of policy | public: true. effects is required (effect-scan verifies, A4002).
Key order (A1005): intent, route, input, output, policy|public, subject, requires, ensures, effects, idempotency, transaction, run|handler, owner, tags.
Declared pipeline (run present):
validate 400 -> authorize 401/403 -> [tx] load self, snapshot old -> requires 412 -> run (500 HandlerError) -> reload self -> ensures + invariants 500 -> commit -> emit buffered events (failure is trace-only).
- transaction defaults true ({ timeout, maxWait } passthrough); false runs on the plain client and an ensures failure reports committed: true.
- subject: { entity, where } selects at most one row behind self/old.
- idempotency is a fact in V0: no runtime dedupe.
Observe mode: no run, route required, handler optional (only feeds effect-scan).`,
  query: `# query(id, options)
A declared read. Has policy | public, input, output, and run (ctx.db, no transaction) or observe mode (route required, handler optional).
- No requires, ensures, effects, subject or transaction.
- The compiler adds verified reads edges from the body and reports any write (A4004).
- Key order: intent, route, input, output, policy|public, run|handler, owner, tags.`,
  event: `# event(name, options)
Flat payload of PayloadType values. PascalCase name.
- emit(Event, payload) is typed from the payload; every emit target must be declared (A4001).
- external: true suppresses A4003 (no consumer expected).
- e.emitted(Event, n) counts the buffered (declared) or spied (observe) emits; only valid in ensures.
- Averri has no event bus; configure emitter.publish, emitter.spy and eventNamePrefix in averri.config.ts.`,
  workflow: `# workflow(name, options)
Binds on: Event to a runner (Inngest, pg-boss or custom). Averri never executes runners.
- Resolves runner to a SymbolRef, adds consumedBy edges, infers engine from the runner's import, scans step.run("name") literals.
- retry is a recorded fact, compared with the runner's own configuration when exposed.
- Generated test: consumer exists for the event.
- Event names are matched statically, so use string literals (event: "averri/MemberInvited").`,
  integration: `# integration(name, options)
Declares a foreign client and its pitfalls.
- webhook: { verify, scheme: "stripe" | "hmac-sha256" | "custom", secretEnv?, rawBody, route? } tells testgen how to sign bodies.
- rawBody: true adds the pitfall.raw-body test and A5001 (body parsed before signature check).
- idempotency generates the duplicate-delivery test and suppresses A5002.
- nonTransactional (default true): calling the client inside an Averri transaction is A4005.`,
  contracts: `# Contracts
Phases: requires, ensures, invariant (entity), allow (policy). Clause = key of the phase object.
- e.eq/ne/lt/lte/gt/gte(lhs, rhs); e.and/or/not; e.in; e.isNull; e.len; e.sum; e.count; e.exists; e.emitted(Event, n).
- db.exists/none/unique(model, where); db.countWhere inside a comparison. model is a Prisma accessor (A1003); where keys are fields or dotted to-one relations, depth <= 3; no OR, no list relations (A3009).
- Undefined ref in a where fails closed: the predicate is false (also db.none), the call is skipped, undefinedRefs is recorded.
- Guards: async ({ input, actor, self, old, result, prisma }) => boolean; never combine with e.and/or/not; A3005 suggests a tier 1/2 form.
- Weakening a contract is reported by impact and check (contractsWeakened) and needs acknowledgeWeakening.`,
  identity: `# Identity
Node id = "<Kind>:<qualifier>", for example Action:Team.inviteMember, Entity:Team, Exposure:<router>:<file>:<line>:<col>, Contract:Team.inviteMember.requires.notAlreadyMember, Test:gen/Team.inviteMember.auth-matrix.
- Tools accept a full id or a bare qualifier (Team.inviteMember) when exactly one node has it; otherwise ambiguous with candidates.
- Never pass file paths as ids.
- The id string in action("Team.inviteMember") is the durable identity: renaming the TypeScript constant does not change it.
- Origins: extracted (heuristic, has evidence and confidence), declared, verified (every applicable verifier passed).`,
  tests: `# Generated tests
Written to tests/averri/*.gen.test.ts, one file per owner. Never edit them; check regenerates them when sourceHash changes.
Suites: auth-matrix (every config.actors fixture), precondition (each requires clause violated), postcondition, event, invariant, consumer, pitfall.idempotency, pitfall.webhook-signature, pitfall.raw-body.
- Titles: [Test:gen/<owner>.<suite>] [Contract:...|Policy:...] text.
- Tier-3 guards get no tests; clauses that cannot be derived become it.todo with a reason.
- Hand-written tests are linked by what they cover; check counts both kinds.`,
  graph: `# Graph and cache
.averri/graph.json is rebuilt whenever the content hash of the input files changes; every tool response says stale: false and whether this call rebuilt.
- Node kinds: Action, Query, Exposure, Entity, Policy, Event, Workflow, Integration, Contract, Test, Field, Module.
- Edges include contains, constrains, authorizes, exposes, reads, writes, emits, consumedBy, verifiedBy, dependsOn (dependents are affected when a node changes). Full list in SPEC-IR.
- Below confidence 0.9 a tool returns verify (or low-confidence for the target): read_source the cited location.
- .averri/snapshots, last-check.json, last-green.json and traces/ live next to the graph.`,
  check: `# check
Typecheck + compiler diagnostics + affected generated tests, structured. Use instead of raw tsc/vitest.
- scope: "affected" (default; dirty tree = HEAD..working tree, clean = last-green..HEAD, else all) or "all".
- green = no error diagnostics, no failed tests, and no weakened contracts or removed policies unless acknowledgeWeakening: true.
- Diagnostics: A1xxx declarations, A2xxx exposure, A3xxx contracts, A4xxx effects, A5xxx pitfalls, A6xxx tests, A9xxx tsc/test failures. Prefer the first fix on a diagnostic.
- Failures carry rerun, a pasteable vitest command; use explain for the chain.`,
  config: `# averri.config.ts
export default defineConfig({ ... }); the compiler lowers static fields and never imports the file.
- sourceRoots ["src"], prismaSchema "prisma/schema.prisma", entryPoints (files that build the app).
- authMiddleware: names that establish actor (A2103 for undeclared routes); publicMarker: middleware marking an intentionally public route.
- actors: fixtures { actor, headers }; anonymous with actor: null is mandatory; the auth matrix iterates all of them.
- emitter: { eventNamePrefix, publish, spy: { target, method } }.
- sampling: { ensures: 0, invariants: 0 } in production; test: { databaseUrlEnv, generatedDir: "tests/averri" }.`,
};

export const DOC_NAMES: string[] = Object.keys(DOCS);

export const DOC_URI_PREFIX = "averri://docs/";
export const CARD_URI_PREFIX = "averri://card/";

export function docUri(name: string): string {
  return `${DOC_URI_PREFIX}${name}`;
}

export function docText(name: string): string | null {
  return DOCS[name] ?? null;
}
