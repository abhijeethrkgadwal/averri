# SPEC-MCP — The agent interface

Status: normative for V0. Implemented by `@averr/mcp` (MCP server over stdio and HTTP) and `@averr/cli` (`averr <tool> --json` with byte-identical JSON output). Both call `@averr/compiler`; neither contains graph logic. Decisions are logged in `SPEC-DECISIONS.md` (`D-n`).

## 1. Principles

- **Six tools plus two passthroughs.** `overview`, `find`, `inspect`, `impact`, `check`, `explain`; plus `read_source` and `suggest`. No `apply_patch`, no IR op vocabulary, no session deltas, no `conventions` tool (folded into `overview`/`inspect`), no text search (D-26: `find` covers graph nodes; the agent block tells agents to grep for call sites, middleware chains, env usage and string literals).
- **Never stale, never silent.** Every call rebuilds on demand by content hash (§4). Every response carries the envelope in §3 with `stale: false`. A server that cannot rebuild returns an error, not an old answer.
- **Bounded output.** Each tool has a token budget. The server truncates at item boundaries, sets `truncated: true`, and returns `more` handles. Budgets are measured as `ceil(chars / 4)` of the serialised JSON.
- **Evidence, not confidence.** Extracted facts carry evidence strings; below confidence 0.9 the server refuses to assert and points at `read_source`.
- **Docs are resources.** Construct semantics cards are MCP resources at `averr://docs/<construct>`; they cost nothing until fetched.

## 2. Transport

- MCP over stdio (`averr mcp`) and streamable HTTP (`averr mcp --http <port>`), using `@modelcontextprotocol/sdk`.
- CLI mirror: `averr overview --json`, `averr find --json --query ...`, etc. Output MUST be the same JSON the MCP tool returns. Without `--json` the CLI prints a human rendering.
- `averr init` writes the agent block (≤ 40 lines, §8) into `CLAUDE.md`, `AGENTS.md` and `.cursor/rules`, writes `averr.config.ts` and `src/averr.d.ts`, adds the devDependencies generated tests need (`vitest`, `fast-check`, `@averr/contracts`), and registers the MCP server in the detected agent's config.

## 3. Response envelope

Every tool result is:

```ts
interface Envelope<T> {
  ok: true;
  commit: string | null;     // graph.meta.commit
  dirty: boolean;            // graph.meta.dirty
  builtAt: string;           // graph.meta.builtAt
  stale: false;              // always false; see §4
  rebuilt: boolean;          // true if this call triggered a rebuild
  truncated: boolean;
  more?: string[];           // handles (node ids or cursors) the caller can pass back
  data: T;
}
type ToolError = { ok: false; error: "build-failed" | "not-found" | "ambiguous" | "low-confidence" | "bad-input"; message: string; diagnostics?: Diagnostic[]; candidates?: string[] };
```

## 4. Staleness rule

1. Compute `contentHash` over the input file set (SPEC-IR §6; generated tests excluded).
2. If `.averr/graph.json` exists, validates against `GraphSchema`, and `meta.contentHash` matches → serve it.
3. Otherwise rebuild. If the build throws (not: produces diagnostics) → return `{ ok: false, error: "build-failed" }` with whatever diagnostics exist. Never serve the previous graph.
4. Concurrency: builds are serialised through a lock file `.averr/build.lock`; concurrent callers (subagents) wait, then re-check the hash. There is no file watcher.
5. Target: incremental rebuild < 3 s on 60 k LOC. `check` additionally runs tsc and Vitest and targets < 10 s on 20 k LOC with `scope: "affected"`.

## 5. Confidence rule

When a tool's answer depends on an extracted node with `confidence < 0.9`, the server MUST NOT state the fact plainly. Every place a node appears (`find` hits, `inspect.node`, `impact.affected[]`, `explain.chain[]`) carries `verify?: string` populated from the node's provenance evidence, e.g. `"read src/routes/teams.ts:41 — dynamic mount, handler not statically resolvable"`. For `impact {id}` and `inspect {id}`, when **the target node itself** has confidence < 0.9 the response is `{ ok: false, error: "low-confidence" }` with the node ids as `candidates`. The agent then calls `read_source`.

## 6. Tools

Input schemas are given as zod 4; the MCP tool definitions MUST be generated from them with `z.toJSONSchema`. Every input schema is a `z.object(...)` at the root (MCP requires `type: "object"`); alternatives are expressed with optional fields plus `.refine`.

Id arguments accept a full `NodeId` (`Action:Team.inviteMember`) or a bare qualifier (`Team.inviteMember`) when exactly one node has it; otherwise `{ ok: false, error: "ambiguous", candidates }`. File paths are never ids.

### 6.1 `overview` — session orientation (≤ 1 200 tokens)

Input: `z.object({})`.

Output `data`:

```ts
{
  stack: StackSummary;                                  // orm, routers, validator, testRunner, entryPoints, commands, conventions (≤5 lines)
  counts: Record<NodeKind, number>;
  health: HealthCounters & { opaqueGuardRatio: number; handlerLineRatio: number; handlerLineRatioNote: "informational in V0" };
  topModules: Array<{ file: string; actions: number; exposures: number }>;  // ≤ 8
  quickstart: string;                                   // 5 lines: how to work here (the agent block is the ≤ 40-line file written by init)
}
```

Rules: call once per session. Must fit the budget without truncation on the reference app; if it does not, drop `topModules` first.

### 6.2 `find` — locate by name or meaning (≤ 800 tokens)

Input:

```ts
z.object({
  query: z.string().min(1),
  kind: z.enum(NODE_KINDS).optional(),
  limit: z.number().int().min(1).max(30).default(20),   // ~80 chars per hit; above 30 the budget always truncates
})
```

Output `data`: `{ hits: Array<{ id: NodeId; kind: NodeKind; path: `${string}:${number}` | null; origin: Origin; summary: string; verify?: string }> }`, rendered by the CLI as one line per hit: `id | kind | path:line | origin | summary`. `path` is null for Contract and generated Test nodes without a source span.

Matching: exact id → prefix of qualifier → case-insensitive substring over `name`, `summary`, `intent`, route path → token overlap. Results sorted by match class then kind priority (Action, Query, Exposure, Entity, Policy, Event, Workflow, Integration, Contract, Test, Field, Module). No embeddings in V0. Drop order under budget: hits from the end, then `summary` strings. `find` does not search source text: use grep for call sites, middleware and string literals.

### 6.3 `inspect` — everything about one node (≤ 2 000 tokens)

Input:

```ts
z.object({
  id: z.string(),                                                        // NodeId, or a bare qualifier if unambiguous
  include: z.array(z.enum(["source", "history", "tests"])).default([]),
})
```

Output `data`:

```ts
{
  node: Node;                                           // full payload
  verify?: string;                                      // present when node confidence < 0.9
  card: SpecCard;
  edges: Partial<Record<EdgeKind, NodeId[]>>;           // grouped from this node's perspective, both directions
  dependents: NodeId[];                                 // incoming dependsOn (nodes affected when this one changes), ≤ 20
  tests?: Array<{ id: TestId; suite: string; file: string; lastResult: TestResultSummary | null }>;
  history?: { entries: HistoryEntry[]; truncated: boolean };  // ≤ 10 ops over ≤ 20 commits / 10 s (SPEC-IR §7)
  source?: string;                                      // inline only when ≤ 400 tokens, else omitted with a read_source hint in `more`
  diagnostics: Diagnostic[];                            // open diagnostics on this node
}
interface SpecCard {
  intent: string | null;
  whoMay: string;                                       // rendered policy, or "opaque", or "public"
  preconditions: Array<{ clause: string; tier: ContractTier; text: string }>;
  postconditions: Array<{ clause: string; tier: ContractTier; text: string }>;
  invariants: Array<{ clause: string; text: string }>;  // for Entities
  effects: string[];                                    // "writes Invitation", "reads Membership (policy, requires)", "emits MemberInvited → InviteFlow"
  tests: string[];                                      // "auth-matrix (4) green"
  owner: string | null;
  lastChange: string | null;
}
```

### 6.4 `impact` — what breaks if this changes (≤ 1 500 tokens)

Input (exactly one of `id`, `diff`, `base`, or none):

```ts
z.object({
  id: z.string().optional(),                            // node id or bare qualifier
  diff: z.string().min(1).optional(),                   // unified diff against the working tree or HEAD
  base: z.string().optional(),                          // git ref; diff = base..working tree
}).refine(atMostOneOf("id", "diff", "base"))
```

`{}` means "my uncommitted edits": HEAD vs working tree (the same default `check` uses). On a clean tree with no `base`, `{}` means last-green..HEAD; with no last green it is an empty impact with `message: "nothing changed"`.

Output `data`:

```ts
{
  changed: NodeId[];                                    // nodes directly touched (by id, or by mapping diff hunks through Module.contains and src ranges)
  affected: Array<{ id: NodeId; why: NodeId[]; verify?: string }>;  // via dependsOn (SPEC-IR §5 table); `why` is the edge path, ≤ 2 hops
  testsToRun: Array<{ id: TestId; suite: string; file: string; covers: NodeId[] }>;   // ≤ 20; rest in `more`
  migrationNeeded: boolean;                             // any Field/Entity change on a Prisma model
  apiBreaking: boolean;                                 // route removed/renamed, input field removed or narrowed, output field removed
  contractsWeakened: Array<{ contract: ContractId; op: "remove-contract" | "weaken-contract" | "change" }>;
  policiesRemoved: PolicyId[];
  diff?: GraphDiff;                                      // only for the diff/base/{} forms, truncated to ops
}
```

Rules: with `{diff}` the server builds the graph for the working tree and for the tree with the diff reverted (or for `base`), then runs `diffGraphs`. Undecided contract changes appear in `contractsWeakened` with `op: "change"`.

### 6.5 `check` — typecheck + lint + affected tests, structured (≤ 2 000 tokens)

Input:

```ts
z.object({
  scope: z.enum(["affected", "all"]).default("affected"),
  diffBase: z.string().optional(),                      // git ref for "affected"; default: HEAD vs working tree
  acknowledgeWeakening: z.boolean().default(false),     // see `green`
})
```

Output `data`:

```ts
{
  diagnostics: Diagnostic[];                            // compiler + cascade-collapsed tsc (A9001) + failed tests (A9002), errors first
  tests: { ran: number; passed: number; failed: number; skipped: number;
           failures: Array<{ testId: TestId; contract?: ContractId; title: string; file: string; traceId?: string; rerun: string }> };
  coverage: { generated: number; handWritten: number; message: string;      // "N generated + M hand-written tests cover your change"
              tests: Array<{ id: TestId; suite: string; file: string; generated: boolean }> };   // ≤ 20; rest in `more`
  contractsWeakened: Array<{ contract: ContractId; op: "remove-contract" | "weaken-contract" | "change" }>;  // vs diffBase / last green
  policiesRemoved: PolicyId[];
  green: boolean;                                       // no error diagnostics, no failed tests, and (contractsWeakened ∪ policiesRemoved empty or acknowledgeWeakening)
}
```

Rules:

- `scope: "affected"` with a dirty tree = tests from `impact` of HEAD..working tree plus any test touching changed files. With a clean tree and no `diffBase`, "affected" means last-green..HEAD; with no last green it falls back to `all`. The affected set is never silently empty: if it would be, the response says so in `coverage.message` and runs all generated tests.
- `rerun` is a pasteable command, e.g. `npx vitest run tests/averr/Team.gen.test.ts -t "[Contract:Team.inviteMember.requires.notAlreadyMember] violation is rejected"`.
- `check` regenerates `tests/averr/*.gen.test.ts` when their `sourceHash` changed; a diff touching those files after `check` is expected.
- `check` writes `.averr/last-check.json` (`{ meta: { contentHash }, diagnostics, tests }`) every run, and on green writes `.averr/last-green.json` (`{ meta, tests, at, snapshot: "snapshots/<contentHash>.json" }`) and pins that snapshot. `since_last_green` in diagnostics is computed against the pinned snapshot. tsc errors are collapsed per SPEC-DIAGNOSTICS §5.

### 6.6 `explain` — why a test, diagnostic or trace failed (≤ 1 500 tokens)

Input:

```ts
z.object({
  testId: z.string().optional(),
  diagId: z.string().optional(),                        // D-0042 from the last `check`
  diag: z.object({ code: z.string(), node: z.string() }).optional(),   // stable alternative key
  traceId: z.string().optional(),
  detail: z.enum(["summary", "full"]).default("summary"),
}).refine(exactlyOneOf("testId", "diagId", "diag", "traceId"))
```

`diagId` resolves against `.averr/last-check.json`; if its `contentHash` differs from the current graph the result is `{ ok: false, error: "not-found", message: "diagnostics were from build <hash>; run check again" }`. `diag: { code, node }` resolves against the current graph's diagnostics and survives rebuilds.

Output `data`:

```ts
{
  subject: { kind: "test" | "diagnostic" | "trace"; id: string };
  failure: { assertion: string; actual: unknown; expected: unknown } | null;
  triggeringInput: { method?: HttpMethod; path?: string; body?: unknown;
                     actor?: { fixture: string; id: string | null } } | null;   // pasteable; `fixture` is a key of config.actors
  rerun?: string;                                                                // same shape as check.tests.failures[].rerun
  chain: Array<{ node: NodeId; role: "exposure" | "route" | "policy" | "contract" | "handler" | "event" | "workflow" | "test"; note: string; path: string | null; verify?: string }>;
  sinceLastGreen: GraphDiffOp[];                        // ops touching nodes in the chain
  declaration: { contract: ContractId; path: string; author: string | null } | null;
  trace?: ActionTrace;                                  // detail: "full" only
  stack?: string;                                       // detail: "full" only
}
```

Rules: no hypotheses. `explain` returns actual-vs-expected, the chain and the diff; it does not guess a fix. For diagnostics with deterministic fixes the fix is already on the diagnostic. Traces are joined to tests through `ActionTrace.test` and the `[Test:...]`/`[Contract:...]` prefixes in generated titles.

### 6.7 `read_source` — passthrough (≤ 4 000 tokens, hard cap by range)

Input: `z.object({ file: z.string(), range: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional() })` (1-based inclusive line range).

Output `data`: `{ file, range, text, lines: number }`. Refuses files outside the project root and files matching `.gitignore` except `.averr/traces`. Never truncates inside a line; if the range exceeds the budget it returns the first N full lines and `more: ["file:<nextLine>"]`.

### 6.8 `suggest` — draft declarations (≤ 2 000 tokens)

Input: `z.object({ id: z.string().optional() })` — an Exposure id, an Action id (to draft missing intent/contracts), or empty for the top 5 undeclared exposures ranked by the number of Prisma write operations in the handler, then by path depth (undeclared Exposures have too few edges for an edge-based ranking).

Output `data`: `{ proposals: Array<{ target: NodeId; patch: string; evidence: string[] }> }` where `patch` is a unified diff adding an `action()`/`query()` in observe mode next to the handler's module, with `input` taken from the detected Zod schema, `route` from the Exposure, `policy` reused from sibling actions in the same file when ≥ 2 siblings share one, `requires` drafted from `if (...) throw/return 4xx` patterns in the handler, and `intent` left as a `TODO:` line. Proposals are never applied by the server.

## 7. Resources

| URI | Content | Size |
|---|---|---|
| `averr://docs/core` | the core card: the observe-mode example from SPEC-DECLARATIONS §6 (the adoption path), the ref-root × phase table (6 lines), the lhs-path/rhs-literal rule, the `effects` and `PayloadType` literal lists, the construct list, and a pointer to `averr://docs/action` for the declared-mode pipeline | ≤ 1 500 tokens |
| `averr://docs/<construct>` for `entity, policy, action, query, event, workflow, integration, contracts, identity, tests, graph, check, config` | semantics card: ordering, transaction boundary, phase rules, pitfalls; `config` documents `averr.config.ts` (SPEC-DECLARATIONS §9) | ≤ 300 tokens each |
| `averr://card/<NodeId>` | the Markdown spec card for one node (URI-encoded id) | ≤ 15 lines |

## 8. Agent block written by `averr init`

Content (normative wording, ≤ 40 lines):

- call `overview` once per session;
- call `find` or `impact` before editing an entity, route, policy or contract; pass ids as `Action:Team.inviteMember` or bare `Team.inviteMember`, never file paths;
- run `check` instead of raw `tsc`/`vitest`; `check` regenerates `tests/averr/*.gen.test.ts`, so a diff touching them is expected;
- trust generated contract tests and do not edit `tests/averr/*.gen.test.ts`;
- if a contract must be weakened or removed, say so explicitly in the PR description and pass `acknowledgeWeakening: true` to `check`;
- contracts: the left side of a comparison is a path string (`"result.email"`), the right side is `e.<root>()` or a literal; tier-3 clauses are bare `async (ctx) => boolean` functions and get no generated tests, so prefer `e.*`/`db.*`;
- when a tool says low-confidence or returns `verify`, use `read_source`;
- use `find` for entities, routes, policies, contracts and tests; use grep for call sites of ordinary functions, middleware chains, env/config usage and error-message strings;
- prefer the first `fix` on a diagnostic; state in the PR when you chose another.

## 9. Implementation notes for `@averr/mcp` and `@averr/cli`

- One module per tool under `packages/mcp/src/tools/`, each exporting `{ name, inputSchema, handler }`; `packages/cli` imports the same modules and prints `JSON.stringify(result)` for `--json`. No logic duplication between MCP and CLI.
- Budget enforcement is a shared `bound(data, budget, dropOrder)` helper that removes list items from the end in the documented drop order and sets `truncated`/`more`.
- Build and staleness live in `@averr/compiler` (`loadOrBuild(root): Promise<Graph>`); the MCP server never reads `.averr/graph.json` directly.
- Token-usage telemetry is out of scope: an MCP server cannot see token counts and MUST NOT pretend to.
- Tool descriptions sent to the model are the first sentence of each §6 heading plus the budget; keep them under 30 words each so the tool schema cost charged to arm B of the benchmark stays small. They cannot carry the id grammar, which is why the agent block does.
