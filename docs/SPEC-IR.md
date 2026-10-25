# SPEC-IR — The Averri Semantic IR

Status: normative for V0. Implemented by `@averri/ir` (types, schemas) and produced by `@averri/compiler`.
Source of truth for types: `packages/ir/src/types.ts`. Where this document and that file disagree, the file wins and this document has a bug. Decisions that deviate from the FINAL design document or from review findings are logged in `SPEC-DECISIONS.md` (`D-n`).

The key words MUST, MUST NOT, SHOULD, MAY are to be interpreted as in RFC 2119.

## 1. What the IR is

The Semantic IR is a typed property graph describing a TypeScript backend on Prisma + Hono/Express + Zod: its entities, actions, policies, contracts, events, workflows, integrations, HTTP exposures, tests and source modules, plus the edges between them.

- The IR is **derived**. It is a pure function of (repository content, Averri version). It MUST NOT be committed, hand-edited or patched.
- The IR is a **cache**. It lives in `.averri/graph.json` (gitignored), is rebuilt on demand by content hash, and MUST validate against `GraphSchema` when read back. A cache that fails validation MUST be discarded and rebuilt.
- The IR carries **provenance** on every node and edge: `extracted`, `declared` or `verified`. Tools MUST surface provenance; they MUST NOT present an extracted fact as verified.
- The IR stores contracts as a **serializable AST**, never as function source. Opaque guards are recorded as opaque.
- The IR is built **statically**. The compiler reads source with ts-morph and `@mrleebo/prisma-ast`; it never evaluates user modules (D-2). "Schema facts" below means what the Prisma extractor derives from `schema.prisma`; Averri does not use the DMMF.

## 2. Identity

### 2.1 Node ids

A node id is `<Kind>:<qualifier>`. The set of kinds is closed (`NODE_KINDS`). Qualifier grammar per kind:

| Kind | Qualifier | Example |
|---|---|---|
| Entity | Prisma model name (PascalCase) | `Entity:Invitation` |
| Field | `<Entity>.<field>` | `Field:Invitation.status` |
| Action | the declared id string | `Action:Team.inviteMember` |
| Query | the declared id string | `Query:Team.listMembers` |
| Policy | the declared id string | `Policy:Team.OwnerOrAdmin` |
| Contract | `<ownerQualifier>.<phase>.<clause>`; for policies `<policyQualifier>.allow` (no clause) | `Contract:Team.inviteMember.requires.notAlreadyMember`, `Contract:Invitation.invariant.pendingHasNoAcceptedAt`, `Contract:Team.OwnerOrAdmin.allow` |
| Event | declared name | `Event:MemberInvited` |
| Workflow | declared name | `Workflow:InviteFlow` |
| Integration | declared name | `Integration:Stripe` |
| Exposure | `<router>:<file>:<line>:<col>` of the method identifier of the registration (`post` in `app.post(...)`), col 0-based | `Exposure:hono:src/routes/teams.ts:41:4` |
| Test | `gen/<ownerQualifier>.<suite>` (generated) or `<file>:<line>` (hand-written) | `Test:gen/Team.inviteMember.auth-matrix`, `Test:tests/members.test.ts:17` |
| Module | repo-relative POSIX path | `Module:src/members/inviteMember.ts` |

Rules:

- The string passed to a declaration call (`action("Team.inviteMember", ...)`) IS the identity. There are no ULIDs and no reconciliation file.
- Two declarations with the same id in one project are an error (A1001). The compiler MUST still emit both nodes' diagnostics but MUST keep only the first in source order in the graph, where source order is (repo-relative path ascending, byte-wise) then position within the file.
- When an id disappears between two builds and a new id appears whose `run`/`handler` symbol reference is identical, the compiler MUST report A1002 (rename) and the diff MUST emit a `rename` op rather than `remove` + `add`. Tie rule: if the symbol is shared by two or more declarations on either side (two observe-mode declarations referencing one handler), no rename is reported.
- Exposure ids change when a route registration moves. This is accepted: Exposures are extracted facts, and an Action's `route.exposure` is re-resolved on every build. Tools MUST NOT persist Exposure ids across builds. The column makes two registrations on one line (loops, chained calls) distinct.
- Clause names starting with `$` are reserved for synthetic contracts (`requires.$subject`); declaring one is A1004.
- Ids are not file-safe. Every id-derived path under `.averri/` (cards, snapshots of a node) uses `encodeURIComponent(id)` (`nodeIdToFileName` in @averri/ir, D-24).

### 2.2 Paths and positions

- File paths are repo-relative, POSIX separators, no leading `./`.
- `Position` is `[line, column]`: line 1-based, column 0-based. `path` strings in diagnostics are `file:line`.
- ts-morph's `getLineAndColumnAtPos` returns a 1-based line AND a 1-based column; every extractor subtracts 1 from the column. Node `getStartLineNumber()` is 1-based and used as is.
- `SourceRange.range` is `[start, end]`, end exclusive.

## 3. Provenance

```ts
type Provenance =
  | { origin: "extracted"; extractor; confidence: number; evidence: Evidence[] }
  | { origin: "declared";  declaredAt: SourceRange }
  | { origin: "verified";  declaredAt: SourceRange; verifiers: VerifierId[]; evidence: Evidence[] };
```

- `extracted` nodes MUST carry at least one `Evidence` and a `confidence` in `[0, 1]`. Each extractor MUST document how it computes confidence (the route extractors' table is in §4.1).
- `declared` nodes come from `@averri/core` declaration modules lowered by ts-morph. `declaredAt` is the call expression span.
- `verified` is `declared` plus confirmation by **every applicable** static verifier (D-9). `verifiers` lists them all. Applicability: `route-match` when the declaration has `route`; `effect-scan` whenever a `run`/`handler` body is resolvable; `emit-scan` when `event:emit` is declared or an `emitted` clause exists; `zod-match` when `input` resolves to a Zod schema; `consumer-scan` for Events with `external: false`; `test-link` for hand-written Tests. If any applicable verifier fails, the node stays `declared` and the per-field flags (`route.verified`, `effects.verified`) show which one.

| Verifier | What it confirms |
|---|---|
| `route-match` | an Action/Query `route` has an Exposure with the same method and normalised path (§4.1) |
| `effect-scan` | declared `effects` agree with the Prisma calls found in `run`/`handler` (§3.1) |
| `emit-scan` | `emit(Event, ...)` calls in `run` match declared `ensures` `emitted` clauses / `event:emit` effect |
| `zod-match` | the `input` Zod schema's top-level keys exist and agree in type with Prisma fields they are compared to |
| `consumer-scan` | a `workflow({ on })` or integration consumer exists for an Event (matching `eventNamePrefix + name` in runner registrations) |
| `test-link` | a Test file imports/asserts a node id (`// @averri covers Action:...` header) |

- Edges carry their own provenance. A `writes` edge from `effect-scan` is `verified`; a `writes` edge the extractor inferred from a bare `prisma.x.update` call in an undeclared handler is `extracted`.
- Tools MUST refuse to state an extracted fact with confidence below 0.9 as an answer. They MUST instead return the node with a `verify` note and a `read_source` hint (SPEC-MCP §5).

### 3.1 `effect-scan`

The only verifier with non-trivial semantics; it is fully specified so A4002 is decidable.

1. **Client recognition.** An expression is a Prisma client when the TypeChecker's type text is `PrismaClient`, `Prisma.TransactionClient`, or starts with `Omit<PrismaClient,` (extended clients); failing that, when it resolves to the symbol named by `config.prismaClient`. `ctx.tx` / destructured `tx` in `run` are always clients.
2. **Accessor → Entity.** `client.<accessor>` maps to the Entity whose `clientName` (= `Uncapitalize(model)`, e.g. `OAuthToken` → `oAuthToken`) equals the accessor. Unknown accessors are ignored and set `complete: false`.
3. **Operations.** Writes: `create, createMany, createManyAndReturn, update, updateMany, upsert, delete, deleteMany, $executeRaw, $executeRawUnsafe`. Reads: `findUnique, findUniqueOrThrow, findFirst, findFirstOrThrow, findMany, count, aggregate, groupBy, $queryRaw, $queryRawUnsafe`. `$transaction(fn)` recurses into `fn` with its parameter as a client; `$transaction([...])` scans the array elements. Raw ops record the effect without an Entity.
4. **Interprocedural depth.** Project-local callees that receive a client as an argument are followed to depth 3 (`run → service.invite(tx, …) → repo.upsert(tx, …)`). Anything beyond that, dynamic member access (`client[name]`), or a client escaping into an external package sets `effects.verified.complete = false`.
5. **Other effects.** `emit(Event, …)` calls → `emits`; calls on a declared `integration.client` symbol → `calls` (and A4005 when inside a Averri-owned transaction, i.e. within `run` of a `transaction !== false` action).
6. **A4002 rule.** Let `V` = `{ db:write if verified.writes ≠ ∅, db:read if verified.reads ≠ ∅ (body only), event:emit if verified.emits ≠ ∅, network if verified.calls ≠ ∅ }`. With `complete: true`, A4002 fires when `declared ≠ V` and the fix patches `effects` to `V`; with `complete: false`, A4002 fires only when `V ⊄ declared` and the fix only adds. Predicate and policy reads never require `db:read`. Observe-mode declarations without `handler` have `complete: false` and A4002 at `info`.

## 4. Node kinds

Full field lists are in `types.ts`. Semantics that are not obvious from the types:

**Entity.** One per Prisma model, always present once the Prisma extractor has run (origin `extracted`, confidence 0.95+ from the schema facts). An `entity()` declaration enriches the same node: `intent`, `owner`, `invariants`; provenance becomes `declared`. `model` is the schema name (`Invitation`), `clientName` the derived accessor (`invitation`). `idFields` is the primary key (`@id` or `@@id`); `uniques` lists every `@unique` field and `@@unique([...])` group (the example's `teamId_email` compound key). Both feed the fixture generator (SPEC-CONTRACTS §9).

**Field.** Extracted only. `type.kind` is `scalar`, `enum`, `relation` or `unsupported`; scalars and enums carry `list` (`String[]`). Used by A3002/A3006/A3008/A3009 to check contract refs, Zod drift, operator applicability and where paths.

**Action.** `mode` is `declared` (has `run`) or `observe` (no `run`). `route` is the declared route plus the resolved Exposure; `route.verified` is the result of `route-match`. `effects.declared` is what the user wrote; `effects.verified` is what `effect-scan` found, with `complete`. `contracts` lists Contract ids in source order. `ratios` feed the health counters. `subject` is present only when the declaration has one; without it `self.*`/`old.*` refs are errors (A3001). `handler` is the `run` symbol or the observe-mode `handler` reference, null when none was given.

**Query.** A declared read. Carries `policy`/`public` and verified `reads`. MUST NOT have contracts; a scanned write is A4004.

**Policy.** One `allow` Contract (phase `allow`). `tier` mirrors the contract tier. `appliesTo` is a materialised view of incoming `authorizes` edges, present so `inspect` on a Policy needs no edge scan.

**Contract.** One clause. `of` is the owner; `phase` is `requires | ensures | invariant | allow`; `tier` is `expr | predicate | guard`; `expr` is the AST or `null` for guards; `opaque` is `true` iff tier is `guard`. See SPEC-CONTRACTS.

**Event.** Declared payload shape (flat, `PayloadType` values). `external: true` suppresses A4003.

**Workflow.** Binds an Event to an external runner. `engine` is inferred from the runner's import when possible. `steps` are `step.run("name", ...)` string literals found by scanning; absent steps are not an error.

**Integration.** Foreign client plus pitfall facts. `webhook.exposure` is resolved by matching `webhook.route` or by finding the Exposure whose handler reads the `verify` header. `webhook.scheme`/`secretEnv` drive the pitfall tests.

**Exposure.** Extracted route registration; see §4.1. `middleware` lists path-level `use()` middleware matching the path first, then inline arguments, as written (`auth()`, `requireRole("admin")`). `boundTo` is set by `route-match`. `dynamic: true` lowers confidence and flags "verify by reading". `public` is true if the bound declaration says `public: true` or `config.publicMarker` is among the middleware (configured, never guessed).

**Test.** Generated Test nodes are **derived from the graph** (one per `(owner, suite)` that SPEC-CONTRACTS §9 produces), not extracted from generated files (D-13); their `sourceHash` is the hash of the declaration content they derive from, and A6001 compares it with the `hash:` field of the `@generated` header on disk (missing file = stale). Hand-written tests are extracted from Vitest files and linked by `test-link`. `lastResult` is updated by `check`, never by `build`.

**Module.** Every source file the extractor visited. `role` classifies it (`config` for `averri.config.ts`); `hash` and `lines` feed the content hash and the handler-line ratio.

### 4.1 Route extraction (Hono and Express)

**Grammar.** A registration is `X.<method>(path, ...handlers)` where `X` is an app/router instance and `<method>` ∈ `get|post|put|patch|delete|all|on`; `on(methods, path, ...)` expands per listed method; `all` expands to the five `HTTP_METHODS`; `head`/`options` are skipped (no Exposure; D-8). The Exposure's position is the method identifier's line and column, so chained `app\n.get()\n.post()` registrations get distinct positions and two registrations in one line (loops) differ by column.

**Mount-prefix composition.** The extractor builds a mount tree from the entry points: Hono `app.route("/teams", teamsRouter)`, `new Hono().basePath("/api")`, Express `app.use("/teams", router)` and `express.Router()` instances passed to `use`. An Exposure's `path` is the concatenation of every static prefix on the way from an entry point to the registration plus the registered path; a router that is never mounted from an entry point yields Exposures with `dynamic: true` and the unprefixed path.

**Middleware attribution.** `app.use("/teams/*", auth())` and `router.use(auth())` (whole router) are attributed to every Exposure whose composed path matches the `use` pattern, before inline arguments. Identifiers are recorded as written (`auth()`, `requireRole("admin")`), and the bare callee name (`auth`) is what `config.authMiddleware`/`publicMarker` are compared with.

**Normalisation for `route-match`.** Both the declared and the extracted path are normalised before comparison: Hono regex params `:id{[0-9]+}` → `:id`; optional params `:id?` → `:id`; trailing slash removed (except `/`); method upper-cased; consecutive slashes collapsed. Param names must match. Wildcards (`*`, `/:rest*`) never match a declared route.

**Confidence table** (extracted Exposures):

| Situation | Confidence | `dynamic` |
|---|---|---|
| static literal path, identifier or inline handler, statically mounted | 0.98 | false |
| path composed through one or more static mount prefixes | 0.95 | false |
| non-literal path (template with substitutions, variable), or mount via a variable/loop/conditional | 0.6 | true |
| router never reached from an entry point | 0.5 | true |

## 5. Edges

Direction is `from -> to`. The permitted endpoint table is in `types.ts` (`EDGE_KINDS` doc comment). Additional rules:

- `contains` edges from a Module to every node declared or registered in that file MUST exist; they are how `impact {diff}` maps changed files to nodes.
- `dependsOn` is **computed**, written by the compiler's impact pass, never by an extractor or declaration. `X -dependsOn-> Y` means "X is affected when Y changes"; `inspect.dependents` of Y are the incoming `dependsOn` edges. It is not an undirected closure (D-10); it is the transitive application (≤ 2 steps, with `attrs.via` listing intermediates) of this propagation table:

| When this changes | these are affected |
|---|---|
| Entity or Field | nodes with `reads`, `writes` or `returns` edges TO the Entity; Contracts whose `where`/refs name the Field; the `persistedBy` Module |
| Policy | targets of its `authorizes` edges |
| Contract | its `constrains` target and the Tests that `verifiedBy`-cover the Contract or its owner |
| Event | sources of `emits` edges to it and targets of its `consumedBy` edges |
| Module with role `declaration`/`handler`/`route` | nodes it `contains`; Actions/Queries with `validatesWith` or `implementedBy` edges to it |
| Exposure | its `exposes` target |
| Action/Query | its `verifiedBy` Tests; Exposures with `exposes` edges to it |
| Workflow / Integration | their `verifiedBy` Tests |

- `verifiedBy` edges MUST point to a Test node; the Test node's `covers` MUST list the same source. The compiler maintains both.
- Edges are deduplicated on `(kind, from, to)`. When an edge exists at two provenance levels the higher one (`verified` > `declared` > `extracted`) is kept.
- `inspect` presents edges grouped by kind from the node's perspective regardless of direction (an Action shows `authorizes: [Policy:...]` even though the edge is Policy -> Action). The stored direction is canonical; the presentation is not.

## 6. Graph container

```ts
interface Graph {
  meta: GraphMeta;              // schemaVersion, averriVersion, builtAt, commit, dirty, contentHash, root, stack, counts, health
  nodes: Record<NodeId, Node>;
  edges: Edge[];
  diagnostics: Diagnostic[];    // compiler diagnostics of this build (not test results)
}
```

- `meta.contentHash` is sha256 over the sorted list of `(path, sha256(content))` for all input files: every `.ts`/`.tsx` under `config.sourceRoots`, `schema.prisma`, `package.json`, `averri.config.*`, and hand-written test files. Generated tests under `config.test.generatedDir` are **excluded** (they are an output of the build, D-13); A6001 compares them separately. It is the staleness key for SPEC-MCP §4 and the snapshot key (§7).
- `meta.commit` is HEAD or `null` outside git; `meta.dirty` says whether the working tree differs from HEAD. Both are reported on every MCP response.
- `meta.counts` has one integer per `NodeKind`. `meta.health` has the counters in `HealthCounters`; `overview` renders them verbatim.
- `nodes` is keyed by id; `Object.keys(nodes).length === sum(counts)` MUST hold.
- Serialisation MUST be deterministic: node keys sorted, edges sorted by `(kind, from, to)`, diagnostics by `id`. Two builds of identical content MUST produce byte-identical `graph.json` except `meta.builtAt` and `meta.root`.

## 7. History and diff

History is not stored. `inspect include: ["history"]` and `impact {diff}` compute a `GraphDiff` by building the graph at two states (two commits via `git worktree`/`git show`, or HEAD vs working tree) and diffing structurally:

- `add` / `remove` for nodes present on one side only (after rename detection).
- `rename` when an id disappears and another appears with the same `handler`/`run` symbol or the same `src.file` + Exposure method/path (tie rule in §2.1).
- `change` with the dotted property path, `before`, `after` for payload differences.
- `add-contract` / `remove-contract` for Contract nodes, attributed to the owner node.
- `weaken-contract` / `strengthen-contract` when a Contract's AST changes. Weakening is decided by the table in SPEC-CONTRACTS §7; when the rule cannot decide, the op is `change` and the PR bot MUST flag it for review.
- `add-edge` / `remove-edge` for non-`dependsOn` edges; `node` is the edge's `from`, `target` is `<kind>:<from>-><to>`.

Snapshots are cached in `.averri/snapshots/<contentHash>.json` (keyed by content hash, not commit, so dirty trees have snapshots too; D-14); they follow the same schema and validation rule and are LRU-pruned to 20, except the snapshot referenced by `last-green.json`, which is pinned. `history` is bounded: walk at most 20 commits from `git log -- <node.src.file>`, reuse snapshots, stop after 10 ops or 10 s, and report `truncated: true`.

## 8. Health counters

| Counter | Definition |
|---|---|
| `exposures` | Exposure nodes |
| `exposuresWithoutPolicy` | Exposures with `public: false`, `boundTo: null`, and no middleware whose callee is in `config.authMiddleware` (the A2103 warning set; D-7) |
| `exposuresUndeclared` | Exposures with `boundTo: null` |
| `actionsDeclared` / `actionsObserve` | Actions by mode |
| `queries` | Query nodes |
| `contracts` | Contract nodes (all phases) |
| `opaqueGuards` | Contract nodes with `tier: "guard"` |
| `handlerLines` / `totalLines` | lines inside `run`/`handler` bodies of declared nodes vs all TS lines in Modules with role ≠ `test`. **Stage 2 metric**: the ">40% means primitives are too thin" reading applies only once declarations derive code; in V0 `overview` labels it informational |
| `eventsWithoutConsumer` | Events with `external: false` and no `consumedBy` edge |
| `staleGeneratedTests` | generated Tests whose `sourceHash` mismatches the file header or whose file is missing |
| `lowConfidenceNodes` | extracted nodes with confidence < 0.9 |
| `errors` / `warnings` | diagnostics by severity |

## 9. Worked example (abridged)

The `Team.inviteMember` declaration from SPEC-DECLARATIONS produces, among others:

```json
{
  "id": "Action:Team.inviteMember", "kind": "Action", "name": "Team.inviteMember", "mode": "declared",
  "summary": "POST /teams/:teamId/invitations · policy Team.OwnerOrAdmin · 4 contracts (1 opaque) · writes Invitation",
  "provenance": { "origin": "verified", "declaredAt": { "file": "src/members/inviteMember.ts", "range": [[22,0],[48,3]] },
                  "verifiers": ["route-match", "effect-scan", "emit-scan", "zod-match"],
                  "evidence": [{ "kind": "route", "note": "POST /teams/:teamId/invitations registered at src/routes/teams.ts:41:4" },
                               { "kind": "call", "note": "tx.invitation.upsert at 38:16" },
                               { "kind": "call", "note": "emit(MemberInvited) at 43:4" }] },
  "src": { "file": "src/members/inviteMember.ts", "range": [[22,0],[48,3]] },
  "intent": "An owner or admin invites a person by email. Re-inviting a pending email resends; inviting an existing member is an error.",
  "route": { "method": "POST", "path": "/teams/:teamId/invitations", "exposure": "Exposure:hono:src/routes/teams.ts:41:4", "verified": true },
  "input": { "zod": { "file": "src/members/inviteMember.ts", "symbol": "InviteMember.input" }, "fields": ["teamId", "email", "role"] },
  "output": { "entity": "Entity:Invitation" },
  "policy": "Policy:Team.OwnerOrAdmin", "public": false, "subject": null,
  "contracts": [
    "Contract:Team.inviteMember.requires.notAlreadyMember",
    "Contract:Team.inviteMember.requires.emailDomainAllowed",
    "Contract:Team.inviteMember.ensures.pendingForEmail",
    "Contract:Team.inviteMember.ensures.eventEmitted"
  ],
  "effects": { "declared": ["db:write", "event:emit"],
               "verified": { "reads": [], "writes": ["Entity:Invitation"], "emits": ["Event:MemberInvited"], "calls": [], "complete": true } },
  "transaction": true, "idempotency": null,
  "handler": { "file": "src/members/inviteMember.ts", "symbol": "InviteMember.run" },
  "ratios": { "opaqueGuards": 1, "totalContracts": 4, "handlerLines": 9 }
}
```

`effects.verified.reads` is empty because `run` touches only `invitation`; the membership reads come from the policy and the `notAlreadyMember` predicate and are `declared` `reads` edges on those nodes.

```json
{
  "id": "Contract:Team.inviteMember.requires.notAlreadyMember", "kind": "Contract",
  "of": "Action:Team.inviteMember", "phase": "requires", "clause": "notAlreadyMember", "tier": "predicate", "opaque": false,
  "expr": { "op": "db.none", "model": "membership", "where": { "teamId": { "ref": "input.teamId" }, "user.email": { "ref": "input.email" } } }
}
```

Edges (provenance omitted): `Policy:Team.OwnerOrAdmin -authorizes-> Action:Team.inviteMember`, `Exposure:hono:src/routes/teams.ts:41:4 -exposes-> Action:Team.inviteMember`, `Action:Team.inviteMember -writes-> Entity:Invitation` (verified), `Contract:Team.inviteMember.requires.notAlreadyMember -reads-> Entity:Membership` (declared), `Policy:Team.OwnerOrAdmin -reads-> Entity:Membership` (declared), `Action:Team.inviteMember -emits-> Event:MemberInvited` (verified), `Event:MemberInvited -consumedBy-> Workflow:InviteFlow`, `Action:Team.inviteMember -verifiedBy-> Test:gen/Team.inviteMember.auth-matrix`, each Contract `-constrains->` the Action.

## 10. Deviations from the FINAL design document

- Contract ids use the `Contract:` prefix, not the abridged `C:` in the FINAL doc's sketch, so every id follows the single `<Kind>:` rule.
- DB predicate ops are namespaced (`db.exists`, `db.none`, `db.unique`, `db.countWhere`) so that the AST is self-describing; the sketch wrote `"op": "none"`. The list-tier `exists` keeps its bare name.
- Contracts are nodes (`Contract:*`) linked by `constrains` edges rather than only embedded arrays, so impact, history and `verifiedBy` can target a single clause. Action nodes still carry `contracts: ContractId[]` for one-call inspection.
- `subject` is an explicit option on actions. The FINAL doc lists `self`/`old(self)` as expression roots without saying which row they denote; a subject makes that decidable.
- The cache is `graph.json` validated by zod, not SQLite with FTS5: `better-sqlite3` is not among the installed dependencies. The schema is unchanged; SQLite is an implementation upgrade (see ARCHITECTURE §5).
- Prisma facts come from `@mrleebo/prisma-ast`, not `@prisma/internals` `getDMMF` (not installed); the derived set is enumerated in the `types.ts` header.
- Exposure ids carry a column; `verified` provenance carries the list of verifiers; `dependsOn` is a directed propagation table. See `SPEC-DECISIONS.md`.

## 11. Implementation notes for `@averri/ir`

- Export everything from `types.ts` via `index.ts`. Add small pure helpers only: `nodeId(kind, qualifier)`, `parseNodeId(id)`, `contractId(owner, phase, clause | null)` (`clause` is `null` for `allow`), `nodeIdToFileName(id)` (= `encodeURIComponent`), `tierOf(expr | fn)`, `isDbOp(op)`, `sortGraph(graph)`, `validateGraph(json): Graph` (wraps `GraphSchema.parse`), `diffGraphs(base, head): GraphDiff`. No file IO, no ts-morph, no Prisma in this package.
- `validateGraph` MUST reject `schemaVersion !== GRAPH_SCHEMA_VERSION`; callers rebuild.
- `diffGraphs` implements §7 including rename detection and the weakening table from SPEC-CONTRACTS §7; it is used by `impact`, `inspect history` and the PR bot and MUST be deterministic.
- Keep the zod schemas and the TS types in the same file. Each node schema is checked against its interface by the `_SchemaDriftChecks` mutual-assignability aliases: a field added to a TS type without a schema change (or vice versa) fails `tsc`. The node schemas stay `ZodObject`s so `discriminatedUnion` works; the drift check is what makes "the file wins" safe.
