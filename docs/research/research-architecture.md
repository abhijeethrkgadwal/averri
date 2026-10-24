# AgentLang V0/V1 Technical Architecture

Working name: **AgentLang** (`.al` files, package namespace `@agentlang/*`). Domain: backend/API + SaaS services compiled to TypeScript/Postgres.

## 1. Representation layer

### 1a. Surface syntax: new `.al` grammar, not a TS-embedded DSL

Decision: a small, custom declarative grammar for `.al` files, with **TypeScript as the escape hatch** (not the host). Rationale:

- A TS-embedded DSL (Zod/tRPC-style builders) looks familiar but forces the agent to re-parse TypeScript to get semantics, which is exactly the cost we are trying to remove. The type checker becomes the semantic analyzer and its diagnostics are unstructured.
- A dedicated grammar lets the parser produce the IR directly with stable node identity, and lets diagnostics speak in domain terms ("policy `OwnerOnly` does not cover action `Order.cancel`") rather than TS terms.
- Both humans and agents read declarations better than builder chains. The grammar is deliberately small: ~12 top-level keywords, no expressions beyond the contract language, no control flow. Anything imperative goes into `handler` blocks written in TS.

Example `.al`:

```
module billing

entity Order {
  id: Id
  customerId: Ref<Customer>
  status: enum(draft, placed, paid, cancelled) = draft
  total: Money
  lines: List<OrderLine> @owned
  createdAt: Timestamp @auto

  invariant total == sum(lines.price * lines.qty)
  index (customerId, createdAt)
}

policy OwnerOrAdmin on Order {
  allow when actor.id == this.customerId or actor.role == admin
}

action Order.cancel(reason: Text) -> Order {
  authorize OwnerOrAdmin
  requires this.status in [draft, placed]
  requires reason.length > 0
  ensures result.status == cancelled
  emits OrderCancelled { orderId: this.id, reason }
  transaction
  handler ts "./handlers/cancelOrder.ts"
}

event OrderCancelled { orderId: Id, reason: Text }

workflow RefundOnCancel {
  on OrderCancelled
  step refund: call payments.Refund.create(orderId: event.orderId)
  retry 3 backoff exponential
}

service OrderApi {
  expose Order with [list @paginate(cursor) @filter(status, customerId) @sort(createdAt),
                     get, create, update]
  expose Order.cancel
  capability rate_limit(100/min per actor)
}
```

### 1b. Semantic IR as source of truth

The IR is a typed property graph. Node kinds (V0): `Module, Entity, Field, Index, Invariant, Action, Parameter, Contract (requires|ensures), Policy, Event, Workflow, Step, Service, Exposure, Capability, Handler (external TS), Integration (external API/queue), Test, Migration`. Edge kinds: `contains, references (Ref<>), authorizes, emits, consumes, calls, reads, writes, implements (handler→action), verifies (test→contract), derivedFrom (migration→entity version), dependsOn (computed closure)`.

Identity: every node gets a **stable ULID** assigned at creation and stored inline in the source as a trailing annotation only when needed for disambiguation. Default scheme: the canonical path (`billing.Order.cancel.requires[1]`) is the human-facing ID; the ULID is the durable ID that survives renames. Renames are detected by the diff engine (same ULID, different path) and recorded as `rename` operations, which is what makes "what changed" answerable.

IR JSON example (one action, abridged):

```json
{
  "id": "01J9ZK3A7Q2B",
  "kind": "Action",
  "path": "billing.Order.cancel",
  "version": 7,
  "owner": "Entity:01J9ZK2X9QF1",
  "params": [{"name": "reason", "type": {"kind": "Text"}}],
  "returns": {"kind": "Ref", "entity": "01J9ZK2X9QF1"},
  "contracts": [
    {"id": "01J9ZK3B1C44", "phase": "requires",
     "expr": {"op": "in", "lhs": {"field": "this.status"}, "rhs": {"set": ["draft","placed"]}},
     "src": {"file": "billing/order.al", "range": [[21,2],[21,41]]}},
    {"id": "01J9ZK3B1C45", "phase": "ensures",
     "expr": {"op": "==", "lhs": {"field": "result.status"}, "rhs": {"lit": "cancelled"}}}
  ],
  "edges": {
    "authorizes": ["Policy:01J9ZK3A0P01"],
    "emits": ["Event:01J9ZK3C7E22"],
    "implements": ["Handler:01J9ZK3D2H90"],
    "writes": ["Field:01J9ZK2Y1F03"]
  },
  "effects": ["db.write", "event.emit"],
  "capabilities": ["transaction"],
  "history": [{"v": 7, "commit": "a1f3c9", "op": "add-contract", "at": "2026-10-09T14:02:11Z"}]
}
```

Persistence: `.agentlang/graph.sqlite` (one `nodes` table with JSON payload + `edges` table + `history` table, FTS5 index on docs/names for `search_semantics`). SQLite is chosen over a graph DB because it is embeddable, zero-ops, and queries are mostly 1-3 hop. A full-fidelity `ir.json` snapshot is also written per build, which is what gets committed and diffed in git. The SQLite file is a cache, rebuildable from source in seconds.

Diff: structural diff over node ULIDs producing a list of ops: `add, remove, rename, change-field(path, before, after), add-edge, remove-edge`. This op list is the lingua franca for "what changed", for agent patches, and for migration generation.

### 1c. Sync model: text is the source of truth, IR is derived, patches are projected back

Bidirectional sync is the classic trap. Decision for V0/V1:

- `.al` text + handler `.ts` files are the only thing in git that matters.
- IR is derived deterministically by the compiler (`alc build`), cached in SQLite.
- Agents may edit either via **text edits** or via **IR patch operations**. IR patches are applied by a **projection printer**: the patch is validated against the graph, then the printer rewrites only the affected source span (using the `src` ranges on each node) with a canonical formatter (`alfmt`). Because every node carries its source range and the grammar is declaration-oriented (no free-form expressions outside contracts), span-local rewriting is tractable and preserves comments elsewhere.

This gives IR-level ergonomics for agents while keeping git, code review, and human editing on plain text. The IR is never hand-edited.

## 2. Compiler pipeline

```
.al files ──parse──> CST ──lower──> IR (unresolved)
   ──resolve──> IR (bound, ULIDs reconciled against prior ir.json)
   ──check──> diagnostics[] (structured)
   ──plan──> MigrationPlan, GenPlan
   ──emit──> generated/*.ts, openapi.json, migrations/*.sql, tests/*.gen.test.ts
   ──persist──> .agentlang/graph.sqlite, ir.json
```

**Parser: Langium.** Rationale: gives a grammar DSL, generates a TS AST with cross-reference resolution, ships an LSP server for free (VS Code highlighting, go-to-def, hover for humans), and is actively maintained. Tree-sitter is better for the Stage 1 extractor (parsing arbitrary TS/JS) but is a poor fit for a language we own, since it provides no binding/scoping. Chevrotain is fine but hand-rolling scoping and LSP costs weeks. Ohm is too slow for incremental builds. Contract expressions get their own tiny Langium sub-grammar.

**Semantic checks** (each emits a structured diagnostic, see section 4):

- Reference resolution; type checking of fields, params, contract expressions.
- Policy coverage: every exposed action has at least one `authorize` or explicit `@public`. Missing is an error, not a warning.
- Contract well-formedness: `requires` may only reference `this`, params, `actor`; `ensures` may additionally reference `result` and `old(this.x)`.
- Effect consistency: an action declaring `emits X` must have `X` declared; a handler imported by a `transaction` action is forbidden from calling `integration` nodes marked `nonTransactional` (checked via a static scan of the handler's imports, see escape hatch).
- Workflow reachability and cycle detection; every event has at least one consumer or is marked `@external`.
- Invariant decidability: expressions must be in the subset (section 3) or they are rejected.
- Migration safety: destructive changes (drop field, narrow enum) require an explicit `@migrate(drop)` or `@migrate(default=...)` annotation.

**Target stack (concrete):**

- HTTP: **Hono** (small, runs on Node and edge, typed middleware; Fastify is fine but heavier and Node-only, which hurts a future WASM story).
- DB: **Drizzle ORM + drizzle-kit** on Postgres. Drizzle's schema is plain TS objects, trivially generated and readable; SQL-like query builder means the generated code looks like what a human would write. Prisma's schema language would be a second DSL and its generated client is opaque. Kysely is lovely but lacks migration tooling.
- Validation: **Zod** schemas generated per entity/action input, also feeding OpenAPI via `@hono/zod-openapi`.
- Jobs/workflows: **pg-boss** in V0 (one dependency fewer; Postgres only). BullMQ/Redis as a V1 capability `queue(backend: redis)`.
- Auth: **Better Auth** for sessions/OAuth/password; AgentLang `policy` nodes compile to a generated `authorize()` middleware that reads `actor` from the Better Auth session. Own authz, borrowed authn.
- Observability: OpenTelemetry SDK with a custom span processor that feeds the trace store (section 5).
- Tests: Vitest + fast-check.

**Generated code layout** (committed, regenerated idempotently; every file starts with `// @generated by alc <version> from <path> — do not edit`):

```
src/
  generated/
    schema/billing.ts        # drizzle tables, enums, relations
    zod/billing.ts           # input/output schemas
    actions/billing/Order.cancel.ts   # orchestrator: validate→authorize→requires→tx→handler→ensures→emit
    policies/billing.ts
    events/billing.ts        # typed event bus bindings (pg-boss topics)
    workflows/RefundOnCancel.ts
    routes/OrderApi.ts       # Hono router + OpenAPI
    tests/billing.contracts.gen.test.ts
  handlers/
    billing/cancelOrder.ts   # human/agent-authored, never overwritten
migrations/0007_order_cancel_reason.sql
openapi.json
```

Generated action skeleton (abridged):

```ts
// @generated by alc 0.3.1 from billing/order.al#Order.cancel
export const cancelOrder = defineAction({
  id: "01J9ZK3A7Q2B", path: "billing.Order.cancel",
  input: CancelOrderInput,                    // zod
  authorize: policies.OwnerOrAdmin,
  requires: [
    { id: "01J9ZK3B1C44", msg: "this.status in [draft, placed]",
      check: (ctx, self) => ["draft","placed"].includes(self.status) },
    { id: "01J9ZK3B1C46", msg: "reason.length > 0",
      check: (ctx, self, i) => i.reason.length > 0 },
  ],
  ensures: [
    { id: "01J9ZK3B1C45", msg: "result.status == cancelled",
      check: (ctx, self, i, result) => result.status === "cancelled" },
  ],
  effects: { emits: [events.OrderCancelled], transaction: true },
  run: handler, // imported from ../../handlers/billing/cancelOrder
});
```

`defineAction` is a ~150-line runtime in `@agentlang/runtime` that applies the pipeline, records a trace span per phase, and in dev mode enforces contracts (in prod, `requires` always on, `ensures`/`invariant` configurable by sampling).

**Escape hatches (exactly three, no more in V0):**

1. `handler ts "./path.ts"` on an action: the file must export `default async function(ctx: ActionCtx<Order.cancel>, input, self): Promise<Order>`. The compiler generates the `ActionCtx` type so the handler has typed access to `ctx.db` (drizzle tx), `ctx.actor`, `ctx.emit`, `ctx.call`. The compiler also parses the handler with ts-morph and records which generated symbols it imports (adding `reads/writes/calls` edges to the IR), so the graph stays honest even across the boundary.
2. `integration Stripe { client ts "./integrations/stripe.ts", effects [network], nonTransactional }` for foreign APIs.
3. `middleware ts "./mw/x.ts"` on a service for things like custom headers.

"Ejecting" is `alc eject`, which strips the `@generated` headers and deletes `.agentlang/`; the result is a plain Hono/Drizzle project. This is the no-lock-in guarantee and must be demoable in week 12.

**Migrations:** the IR diff between the last committed `ir.json` and the current build produces a migration plan (add column, add index, enum extension, etc.), rendered through drizzle-kit for SQL. Each migration file records the IR diff ops it implements so `show_impact` can link a schema change to a migration.

**Idempotent regeneration:** output is a pure function of (IR, alc version). Files are written only if content hash changes; deleted IR nodes delete their generated files. A `alc check --clean` CI step fails if regenerating produces a diff, which is the drift guard.

## 3. Contracts and test generation

**Expression language (decidable, no recursion, no user functions):**

```
expr := literal | path | expr binop expr | not expr | expr in [..] | old(path)
      | sum(path) | count(path) | len(path) | exists(path) | matches(path, /regex/)
      | actor.<field> | result.<field>
binop := == != < <= > >= and or + - * /
path := (this|param|result|event).field(.field)*  -- max depth 3, through @owned lists only
```

No quantifiers over arbitrary collections except through `sum/count/exists` on owned lists. This keeps every expression evaluable in O(size of entity) at runtime and translatable to a fast-check property.

**What is generated automatically:**

- *Validation boundary tests*: for each field type (Money, Email, Text with length bounds, enum) generate accept/reject cases at boundaries.
- *Precondition tests*: for each `requires`, generate an arbitrary via fast-check that violates exactly that clause and assert a `PreconditionFailed{contractId}` error; and one that satisfies all clauses and asserts the action does not throw a precondition error.
- *Postcondition properties*: `fc.property(validInput, async () => ensures hold)` using the real action against an ephemeral Postgres (testcontainers or `pglite` in-process, which is the V0 default for speed).
- *Auth matrix*: for every (exposed action × policy × actor fixture {anonymous, owner, other user, admin}) generate an expected allow/deny table from the policy expressions and assert it over HTTP.
- *Invariant checks*: generated as runtime assertions after every write to the entity in dev/test; also as a property test "any sequence of 1-5 generated actions preserves the invariant".
- *Event tests*: action emits declared events with the declared payload shape.

**What cannot be generated**: business correctness of handler logic (the agent writes example-based tests for that, and the IR links them via `verifies` edges so coverage of contracts vs handlers is reportable), external integration behavior (mocked via the `integration` node's generated fake), performance.

## 4. Agent protocol (MCP server `@agentlang/mcp`)

Nine tools, each with a `detail: "summary" | "full"` parameter and a hard `max_tokens` budget (default 1500) enforced by the server, which truncates lists and returns `handles` for drill-down.

| Tool | Input (sketch) | Returns | Typical size |
|---|---|---|---|
| `inspect_project` | `{detail?}` | modules, counts per node kind, services, top-level health (errors, uncovered policies, drift) | 300-800 tok |
| `inspect_node` | `{ref: path\|ulid, detail?, include?: ["contracts","edges","history","source"]}` | node JSON (as in 1b), source snippet on `full` | 200-1200 tok |
| `inspect_dependencies` | `{ref, direction: "in"\|"out"\|"both", depth?: 1-3, kinds?}` | adjacency list with node summaries, truncated with handles | 300-1500 tok |
| `search_semantics` | `{query, kinds?, limit?}` | FTS + structural match (e.g. "actions that write Order.status without policy") | 200-800 tok |
| `show_impact` | `{patch: IRPatch[] \| ref}` | nodes affected transitively, migrations implied, tests that would need regeneration, breaking API changes | 300-1500 tok |
| `apply_patch` | `{ops: IRPatch[], dryRun?}` | projected text diff, resulting diagnostics, new node ids | 200-1500 tok |
| `build` | `{}` | diagnostics[] (structured), generated-file summary | 100-2000 tok |
| `run_tests` | `{scope?: ref \| "changed" \| "all", generated?: bool}` | pass/fail counts, failures with contractId + minimal counterexample from fast-check | 200-1500 tok |
| `explain_failure` | `{traceId \| testId \| diagnosticId}` | cause chain over trace + graph, candidate fixes as IR patches | 300-1500 tok |

Plus two passthrough primitives: `read_source {ref|file, range?}` and `edit_source {file, edits[]}` so an agent is never blocked when the IR tools are insufficient.

IR patch ops (JSON-serializable, the same ops the diff engine produces):

```json
[{"op":"add-contract","target":"billing.Order.cancel","phase":"requires","expr":"reason.length > 0"},
 {"op":"add-field","target":"billing.Order","name":"cancelledAt","type":"Timestamp?","after":"createdAt"},
 {"op":"attach-capability","target":"OrderApi.Order.list","capability":"cache(ttl: 30s, key: [customerId])"}]
```

Structured diagnostic:

```json
{
  "id": "D-0042", "code": "AL2103", "severity": "error",
  "title": "Exposed action has no authorization policy",
  "node": "Action:01J9ZK3A7Q2B", "path": "billing.Order.cancel",
  "src": {"file": "billing/order.al", "range": [[19,0],[27,1]]},
  "cause": [
    {"node": "Exposure:01J9ZK4F00A1", "why": "OrderApi exposes Order.cancel"},
    {"node": "Action:01J9ZK3A7Q2B", "why": "no `authorize` clause and no @public"}
  ],
  "fixes": [
    {"label": "Reuse OwnerOrAdmin (used by 3 sibling actions)", "confidence": 0.8,
     "patch": [{"op": "set-authorize", "target": "billing.Order.cancel", "policy": "OwnerOrAdmin"}]},
    {"label": "Mark public", "confidence": 0.1,
     "patch": [{"op": "add-annotation", "target": "billing.Order.cancel", "annotation": "@public"}]}
  ]
}
```

**Edit/validation loop:** agent calls `apply_patch` (dry run) → gets diff + diagnostics → applies → `build` → `run_tests scope:"changed"` → `explain_failure` if needed. The server runs the build incrementally (Langium incremental documents + SQLite upsert), target < 500 ms for a 50-entity project.

**Git ↔ IR history:** a post-commit hook (or `alc snapshot` in CI) stores `ir.json` per commit in `.agentlang/snapshots/<sha>.json` (gitignored, rebuildable). `inspect_node include:history` diffs snapshots by ULID, so "what changed about Order.cancel since v1.2" is a structural op list with commit SHAs and authors, not a text diff. Handler `.ts` changes show as `change-handler` ops with the TS diff attached on `full`.

## 5. Semantic debugger

**V0 (feasible):** the runtime emits one trace per action invocation with correlation id (`traceId`, propagated through emitted events and workflow steps via pg-boss job metadata). Each trace records phases: `validate, authorize(policyId, decision, actorSummary), requires[contractId, pass/fail, evaluated values], tx(begin/commit/rollback), handler(duration, db statements count, calls to integrations), ensures[...], emit[eventId, payload hash]`. Storage: a `traces` table in the app's Postgres (dev) or OTel export (prod), with a 7-day dev retention.

`explain_failure` answers over trace + graph:

- *Why did it fail?* Walk the trace to the first failing phase; attach the contract node, the evaluated LHS/RHS values, and the handler line if it threw.
- *What changed?* Compare the IR snapshot of the failing commit with the last green commit for the nodes in the trace's dependency closure.
- *Who depends on it?* `inspect_dependencies direction:in` on the failing node.
- *Which contracts were violated?* Direct from the trace.
- *Smallest patch?* V0 uses a rule table (missing policy → reuse sibling; failing requires on a new field → add default; ensures violated → highlight handler write sites that touch `result.<field>`). Not learned, just heuristics tied to diagnostic codes.

**Research (post-V1):** counterfactual replay ("would this trace pass with patch P"), automatic minimization of failing action sequences, and learned fix ranking from interaction logs.

## 6. Stage 1: graph over existing TS projects

Feasibility, honestly: **partial**. Using ts-morph (the TS compiler API wrapper) with framework-specific extractors:

- Prisma schema → `Entity/Field/Index` nodes: ~95% accurate, it is already declarative.
- Drizzle schema → same, ~90%.
- Express routes → `Exposure` nodes: ~80% (static `app.get("/x", ...)`), drops to ~50% with dynamic routers.
- NestJS controllers/services/guards → `Exposure, Action, Policy`: ~85% thanks to decorators.
- Zod/class-validator schemas → validation facts: ~80%.
- `Contract`, `Event`, `Workflow`, `Policy` *semantics*: essentially unrecoverable from code. We can detect "there is an `if (!user) throw 403`" but not express it as a policy expression. These become `Opaque` nodes with a `confidence` field.
- Effects (reads/writes): call-graph analysis with ts-morph, ~70%, misses dynamic dispatch.

**Shared IR: yes, by design.** Stage 1 nodes carry `origin: "extracted"` and `confidence: 0-1`; Stage 2 nodes carry `origin: "declared"`. The same MCP tools work on both, which is the real reason to do Stage 1: it validates the tool protocol and the benchmark harness against real codebases before the language exists, and it gives a migration path (`alc adopt` converts high-confidence extracted entities into `.al` declarations, leaving the rest as handlers). Recommendation: do a *narrow* Stage 1 (Prisma + Express/Hono + Zod only, 3 weeks) rather than a general one, because the accuracy ceiling for contracts makes a general Stage 1 a poor benchmark proxy for Stage 2.

## 7. Deliverables

### Repository layout (pnpm monorepo, TypeScript throughout)

```
agentlang/
  packages/
    grammar/        Langium grammar, generated AST, LSP server
    ir/             node/edge types, ULID reconciliation, diff, SQLite store, patch ops + projection printer
    compiler/       lower, resolve, checks, migration planner, emitters (drizzle, zod, hono, pg-boss, tests, openapi)
    runtime/        defineAction, policy evaluator, contract evaluator, event bus, trace recorder
    contracts/      expression parser/evaluator, fast-check arbitrary generator
    mcp/            MCP server (stdio + HTTP), token budgeting, explain_failure rules
    cli/            alc: build, check, test, migrate, snapshot, eject, adopt
    extract-ts/     Stage 1 extractors (ts-morph)
    bench/          AgentCodeBench harness, task definitions, scoring
  examples/
    saas-starter/   orgs, users, projects, invites, billing webhook (the demo app)
  apps/
    vscode/         extension wrapping LSP + graph view
    studio/         V1: web graph explorer (not V0)
  docs/
```

### Tech stack

Node 22, TypeScript 5.x, pnpm, Langium, ts-morph (extractor only), SQLite via better-sqlite3 (+ FTS5), ULID, Hono, @hono/zod-openapi, Zod, Drizzle + drizzle-kit, Postgres 16 / pglite for tests, pg-boss, Better Auth, OpenTelemetry, Vitest, fast-check, @modelcontextprotocol/sdk, Changesets for releases, Turborepo.

### 12-week V0 plan (team of 2-3)

| Week | Milestone | Demo criterion |
|---|---|---|
| 1 | Grammar v0 (entity, field, action, policy, event, service), Langium LSP, `alfmt` | Open `.al` in VS Code with highlighting, errors, go-to-def |
| 2 | IR types, ULID reconciliation, SQLite store, `ir.json` snapshot | `alc build` on the example emits `ir.json`; rename an entity, ULID preserved |
| 3 | Semantic checks (refs, types, policy coverage, contract subset) + structured diagnostics | 10 diagnostic codes with cause chains and at least one candidate fix each |
| 4 | Emit Drizzle schema + Zod + migrations | `alc migrate` creates tables for the SaaS starter in Postgres |
| 5 | Emit Hono routes + OpenAPI + `defineAction` runtime (validate/authorize/requires/ensures/emit) | curl the generated API; 403 from a policy; 422 from a contract |
| 6 | Handler escape hatch with typed `ActionCtx`, handler import scan feeding IR edges, idempotent regen + drift check | Edit handler, `alc check --clean` passes; delete action, generated file removed |
| 7 | Contract test generation (boundary, precondition, auth matrix) with fast-check + pglite | `alc test` runs ~200 generated tests on the example in < 60 s |
| 8 | MCP server: `inspect_project/node/dependencies`, `search_semantics`, `build`, `read/edit_source`, token budgeting | Claude Code / Codex session completes "add a field + endpoint" using only MCP tools |
| 9 | `apply_patch` with projection printer, `show_impact`, git snapshot hook | Agent adds a contract via IR patch; text diff is minimal and formatted |
| 10 | Trace recorder, `explain_failure` over traces + graph with rule-based fixes | Break an invariant, ask "why", get the contract, values and a patch |
| 11 | AgentCodeBench harness: 25 tasks × {TypeScript baseline, AgentLang}, automated scoring | First numbers: tokens, tool calls, iterations, pass rate |
| 12 | Events + pg-boss workflows (minimal), `alc eject`, docs, public repo, benchmark write-up | End-to-end: webhook → event → workflow → refund; ejected project builds standalone |

Stage 1 extractor (narrow) is slotted as a parallel 3-week track for the third person in weeks 8-10, or deferred to V1 if the team is two.

### V1 scope (months 4-9)

Full 100-task benchmark across 5 languages; capabilities `cache, rate_limit, queue(redis), retry, observe, paginate(offset)`; multi-tenancy primitive (`tenant` scoping on entities with generated row-level filters and a policy check that every exposed action is tenant-scoped); Stage 1 extractor for Prisma/Express/Nest; Studio graph explorer; interaction-log mining that proposes new primitives (`alc suggest`); enterprise features that justify the paid tier: SSO for Studio, hosted trace store with retention, org-wide IR registry (cross-repo `inspect_dependencies`), audit log of agent patches, policy-as-code gates ("no agent patch may remove a policy"), and private benchmark runs against the customer's own codebases. The compiler, runtime, grammar, MCP server and CLI stay Apache-2.0; the registry, hosted traces, Studio multi-user, and governance gates are the commercial layer (BSL or closed), which is the standard "open core, charge for the control plane" model and keeps the no-lock-in promise credible.

### Top technical risks and mitigations

1. **Abstraction leakage** (Drizzle/Hono details bleeding into `.al`): keep the grammar closed, no passthrough annotations in V0; every stack-specific need is either a capability or a handler. Track "handler lines / total lines" on the example app; if it exceeds 40 percent the language is too thin.
2. **Escape-hatch explosion**: exactly three hatches, all typed, all scanned so edges stay in the graph; a diagnostic warns when a handler bypasses `ctx.db` (direct pool import) or writes entities it did not declare.
3. **Generated-code drift**: `@generated` headers, content-hash writes, `alc check --clean` in CI, and generated files are never the edit target in MCP (`edit_source` refuses them).
4. **IR/text sync**: one-directional derivation plus span-local projection; a golden test corpus asserts `print(parse(x)) == fmt(x)` and that every patch op round-trips.
5. **Generated-code performance**: the emitter writes what a competent human would write (Drizzle queries with explicit selects, cursor pagination, prepared statements); benchmark the SaaS starter at 1k rps on a laptop by week 10; contracts in prod are sampled.
6. **Multi-tenancy/auth correctness**: policy coverage is a hard error; auth matrix tests are generated, not optional; V1 tenant primitive generates row filters at the query layer and a check that forbids unscoped queries in handlers; a security review of `defineAction` and the policy evaluator before the public release.
7. **Benchmark credibility** (not in the list but existential): fixed model, fixed prompts, tasks and harness public, baseline projects written by humans not by us, report confidence intervals, publish failures.

### Things we will NOT build in V0

A native runtime or Rust/WASM target; a general-purpose expression language or user-defined functions in `.al`; bidirectional IR↔text sync; a graph database; the web Studio; GraphQL, gRPC or WebSocket exposure; non-Postgres databases; Redis-backed anything; custom authn (we borrow Better Auth); frontend/client generation beyond OpenAPI; learned fix ranking or interaction-log mining; the general Stage 1 extractor (narrow Prisma+Express only, and only if a third person exists); a package registry or module versioning across repos; enterprise control plane features. Every one of these is a V1 or V2 decision that the week-11 benchmark numbers should make, not us.