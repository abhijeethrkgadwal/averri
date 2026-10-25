# SPEC-DIAGNOSTICS — Structured diagnostics

Status: normative for V0. Types: `Diagnostic`, `Fix`, `CauseLink`, `DIAGNOSTIC_CODES` in `packages/ir/src/types.ts`. Produced by `@averri/compiler` (S1–S7), by `check` in `@averri/mcp`/`@averri/cli` for S9 backstops. Consumed by every tool and by the PR bot. Code allocations and the review conflicts they resolve are in `SPEC-DECISIONS.md` D-16.

## 1. Format

```json
{"id": "D-0042", "code": "A2101", "severity": "error",
 "title": "Declared route has no matching exposure",
 "node": "Action:Team.inviteMember", "path": "src/members/inviteMember.ts:24",
 "src": {"file": "src/members/inviteMember.ts", "range": [[24,2],[24,66]]},
 "cause": [{"node": "Action:Team.inviteMember", "why": "declares route POST /teams/:teamId/invites"},
           {"node": "Exposure:hono:src/routes/teams.ts:41:4", "why": "registers POST /teams/:teamId/invitations with handler inviteMemberHandler"}],
 "related": ["Exposure:hono:src/routes/teams.ts:41:4"],
 "fixes": [{"label": "Use the registered path", "evidence": "inviteMemberHandler is the handler of exactly one exposure",
            "patch": "--- a/src/members/inviteMember.ts\n+++ b/src/members/inviteMember.ts\n@@ -24,1 +24,1 @@\n-  route: { method: \"POST\", path: \"/teams/:teamId/invites\" },\n+  route: { method: \"POST\", path: \"/teams/:teamId/invitations\" },\n"}],
 "since_last_green": "+1 action",
 "docs": "averri://docs/action"}
```

Field rules:

| Field | Rule |
|---|---|
| `id` | `D-` + zero-padded per-build sequence, assigned in emission order after sorting by severity then path. Not stable across builds. `check` writes its diagnostics to `.averri/last-check.json` (with `meta.contentHash`) so `explain {diagId}` can resolve an id until the content changes. |
| `code` | a key of `DIAGNOSTIC_CODES`. The code's registry severity is the maximum; a rule MAY lower severity for a documented sub-case (A2103 on undeclared exposures → `warning`; A4002 with `complete: false` or without handler → `info`) but MUST NOT raise it. |
| `title` | ≤ 80 chars. States the violated fact, not an instruction. Registry title by default; MAY be specialised with the node name. |
| `message` | optional; one paragraph. The diagnostic **excluding `fixes[].patch`** MUST serialise to ≤ 300 tokens (≈ 1 200 chars); the compiler trims `message`, then `cause` from the end, to fit. Each `patch` is capped at 4 000 chars; a fix whose patch would exceed it is expressed as a `command` instead. |
| `node` | the node the fact is about. `null` only for A9001 outside any known node. |
| `path` | `file:line` to open first. Derived from `src` or, failing that, from `node.src`. |
| `cause` | root cause first; each link one line. Length ≤ 4. Where a cascade cannot be attributed, `cause` has one link: the node itself. |
| `related` | ≤ 5 node ids useful for the fix (candidate policies, sibling actions, the Event declaration). |
| `fixes` | see §3. |
| `since_last_green` | summary of `GraphDiff` ops between the snapshot pinned by `.averri/last-green.json` and now, restricted to nodes in `cause` ∪ `related`: `"+1 action, +1 route, ~1 contract"`. `null` when no green build exists. |
| `docs` | the construct card URI from the registry. |

Ordering in any list: `error` before `warning` before `info`; within a severity by `path`.

## 2. Code registry

Codes are append-only; retired codes are never reused. Reserved, never issued: A2102 (numbering kept from the FINAL doc's W2103), A2107 (Stage 2 tenant-key check). Families: S1 identity · S2 exposure/policy · S3 contracts · S4 effects/events/workflows · S5 integrations/pitfalls · S6 tests · S7 extraction · S9 backstops.

| Code | Sev | Title | Fix? | Trigger | Deterministic fix (when Fix? = yes) |
|---|---|---|---|---|---|
| A1001 | error | Duplicate declaration id | no | two declarations share an id (first in source order kept, SPEC-IR §2.1) | — |
| A1002 | warning | Declaration renamed | no | id disappeared; new id has the same `run`/`handler` symbol (tie rule: shared symbol → no rename) | — (informational; diff emits `rename`) |
| A1003 | error | Unknown Prisma model | no | an entity `name`, `db.*` `model`, `output`, `subject.entity` or event payload entity ref not in the schema facts | — (`related` lists the 3 closest names) |
| A1004 | error | Declaration option is not statically analysable | no | option value outside the subset in SPEC-DECLARATIONS §4.1; or a clause name starting with `$` | — (`message` names the construct and the offending expression kind) |
| A1005 | warning | Declaration keys out of canonical order | no | key order differs from SPEC-DECLARATIONS §4 (`averri fmt` is check-only in V0) | — |
| A2101 | error | Declared route has no matching exposure | yes | Action/Query `route` matched no Exposure after normalisation (SPEC-IR §4.1) | if the declaration's `handler`/`run` symbol, or a `toHono(<Decl>)`/`toExpress(<Decl>)` call, is the handler of exactly one Exposure: patch `route` to that Exposure's method+path |
| A2103 | error / warning | Exposed route has no policy | yes | **warning**: Exposure with `boundTo: null`, `public: false`, and no middleware whose callee is in `config.authMiddleware` (D-7). **error**: a bound declaration with neither `policy` nor `public` (only reachable when tsc is skipped) | error case only, if ≥ 2 sibling declarations in the same module share one policy: patch `policy: <Sibling>`. There is NO `public: true` fallback fix (it would be a hypothesis about authorization); instead `related` lists all Policy ids and `message` says `public: true` is the explicit opt-out |
| A2104 | warning | Exposure has no declaration | no | Exposure with `boundTo: null` | — (`suggest {id}` drafts one) |
| A2105 | error | Exposed declared-mode action has no intent | no | `mode: declared`, has `route`, no `intent` | — |
| A2106 | warning | Policy is an opaque guard; auth matrix not derivable | no | `policy.allow` is a function | — (`related` lists the actions it protects) |
| A3001 | error | self/old reference without a subject | no | `self.*`/`old.*` ref on an action without `subject` | — |
| A3002 | error | Contract references unknown field | yes | ref path or `where` key not a field of the resolved entity/schema; a `where` key named like an operator; a doubled root (`e.input("input.x")`) | if the field was renamed in the diff since last green (one `rename`/`change` op on the Field): patch the ref to the new name; else if a unique case-insensitive match exists: patch to it; for a doubled root: strip the duplicate |
| A3003 | error | Reference root or form not allowed in this phase | no | e.g. `result` in `requires`; `e.emitted` outside `ensures`; `self` in a policy | — |
| A3004 | error | Reference path deeper than 3 segments | no | | — |
| A3005 | warning | Guard could be an expression or predicate | no | guard body matches a tier 1/2 shape (SPEC-CONTRACTS §6) | — (`message` carries the suggested `e.*`/`db.*` text) |
| A3006 | error | Zod input field drifts from Prisma field type | yes | input field compared to or written into a Prisma field of incompatible type (`z.string()` vs `Int`, missing `.nullable()` vs optional) | patch the Zod field to the type derived from the Prisma field |
| A3007 | error | Literal string on the right of a comparison looks like a reference | yes | rhs string literal (or string the checker resolves to a literal) matching `^(input|result|actor|self|old)\.` | patch wrapping it in `e.<root>("<rest>")` |
| A3008 | error | Operator not applicable to operand type | no | `lt/lte/gt/gte` with operands not both numeric or both DateTime; `len` on a non-string/non-list; `sum` on a non-numeric field | — |
| A3009 | error | where path crosses a list relation or nests a db predicate | no | a dotted `where` key traverses a `list: true` relation; `e.sum`, `e.count` or `db.countWhere` inside a `where` operator | — |
| A3010 | error | Reference root looks misspelled | yes | a bare lhs path whose first segment is within edit distance 2 of a ref root and is not a field of the subject (`"reslt.email"`) | patch to the closest root |
| A4001 | error | Emitted event is not declared | yes | `emit(X, …)` in `run`, or `emitted(X)` clause, where X is not an Event node | patch adding `export const X = event("X", { payload: { … } })` with payload keys taken from the emit call's object literal (types from TS) |
| A4002 | warning | Declared effects differ from verified effects | yes | `effects.declared` ≠ `V` per SPEC-IR §3.1 rule 6 (`info` when `complete: false` or no handler) | patch `effects` to `V` when `complete: true`; add-only otherwise |
| A4003 | warning | Event has no consumer | no | Event with `external: false` and no `consumedBy` edge | — |
| A4004 | error | Query handler writes to the database | no | `effect-scan` found a write op in a Query `run`/`handler` | — |
| A4005 | error | Integration called inside a Averri-owned transaction | no | a declared `integration` client with `nonTransactional: true` is called inside `run` of an action with `transaction !== false` | — |
| A5001 | warning | Webhook route appears to parse body before signature verification | no | `webhook.rawBody: true` and the Exposure's Hono inline chain or Express inline arguments contain a JSON body parser (`c.req.json()`, `express.json()`, `bodyParser.json()`) before the call reading the `verify` header. Inline forms only; path-level ordering is not inspected (FINAL §6). The runtime `pitfall.*` tests are the real check | — |
| A5002 | warning | Webhook or payment handler has no idempotency | no | Exposure bound to a webhook integration or whose path matches `/webhooks?/` with no `idempotency` fact and no detected dedupe table access | — |
| A6001 | warning | Generated test is stale | yes | generated Test's `sourceHash` ≠ the `hash:` in the file's `@generated` header, or the file is missing | `{ label: "Regenerate", command: "averri testgen --only <TestId>" }` (no inline patch) |
| A7001 | info | Extracted node below confidence threshold | no | extracted node with confidence < 0.9 | — (`message` says what to read) |
| A9001 | error | TypeScript error | no | tsc backstop after compiler checks | — |
| A9002 | error | Test failed | no | Vitest failure in `check` | — (`explain {testId}`) |

The `deterministicFix` flag in the registry is the single source of truth for the "Fix?" column; a `yes` code is still emitted **without** fixes whenever its precondition does not hold.

## 3. Rules about fixes

1. A diagnostic MAY carry `fixes` only if its code has `deterministicFix: true`. The zod schema does not enforce this; the compiler's emit function MUST assert it.
2. A deterministic fix is one the compiler can produce without a hypothesis: the correct value is implied by the graph (a unique match, a renamed field, a sibling policy used by every neighbour, a regenerated file). Marking a route public is never deterministic. When the precondition in the table does not hold, the diagnostic is emitted **without** fixes even though the code allows them.
3. `evidence` is a sentence naming the facts the fix rests on (`"used by 3 sibling Team.* actions"`). Confidence floats are prohibited anywhere in a diagnostic.
4. A fix has a `patch` (unified diff against the current working tree, ≤ 4 000 chars, applicable with `git apply --check`) or a `command`, or both. The compiler MUST verify `git apply --check` succeeds (dry run in memory) before attaching a patch; a fix whose patch does not apply is dropped.
5. Fixes never touch `@generated` files except A6001, whose only fix is the regeneration command.
6. Logic failures and test failures (A9001, A9002) carry no fixes: `explain` gives actual-vs-expected and the diff since green, with no hypothesis.
7. Fix ordering: the fix the compiler would choose first is first; the agent block tells agents to prefer the first fix and to state in the PR when they chose another.

## 4. When diagnostics are emitted

| Stage | Codes |
|---|---|
| `build` (every tool call, via staleness rule) | S1xxx, S2xxx, S3xxx, S4xxx, S5xxx, A6001, A7001 |
| `check` | all of the above plus A9001 (tsc) and A9002 (Vitest); persisted to `.averri/last-check.json` |
| PR bot (`averri report --base <ref>`) | the `check` set at head, plus weakening flags from `impact` (not diagnostics; a separate report section) |

Extracted-only projects (no `@averri/core` declarations yet) produce only A2103 (warning), A2104, A5002 and A7001; `overview.health.exposuresUndeclared` is the adoption counter.

## 5. Cascade collapse (tsc backstop)

tsc runs after the compiler's own checks. Its errors are grouped before being emitted as A9001:

1. Compute the set of symbols introduced, renamed or removed in the diff since last green (or since `diffBase`).
2. For each tsc error, if its message names one of those symbols (`Property 'x' does not exist`, `Cannot find name 'x'`), attach it to that symbol's group.
3. Emit one A9001 per group: `title` = the first error's message trimmed to 80 chars, `node` = the declaration node containing the symbol's definition if any, `cause[0]` = the diff hunk that introduced the symbol, `message` = `"+N more errors reference '<symbol>'"`.
4. For TS2769 ("No overload matches this call") on a call to a `@averri/core` constructor, `title` is the first `Object literal may only specify known properties` or `Property 'X' is missing` line found in the overload details (the useful line; the overload list is noise).
5. Ungrouped errors are emitted one each, up to 10; the rest are summarised in a final A9001 with `title: "N more TypeScript errors"`.

This is a diff-scoped heuristic. Tool descriptions and docs MUST describe it as such, not as root-cause analysis.

## 6. Implementation notes for `@averri/compiler`

- `emit(code, partial)` is the only way to create a Diagnostic. It fills `severity`, `title`, `docs` from the registry, assigns `id` after sorting, computes `path` from `src`, trims to the token budget (patches excluded), asserts the fix rule (§3.1), dry-run-applies patches, caps patch size, and drops oversize `related`.
- Each rule is a pure function `(graph, context) => Diagnostic[]` under `packages/compiler/src/rules/<code>.ts`, with a fixture-based test per rule (positive, negative, and fix-applies cases).
- `since_last_green` is computed once per build from `diffGraphs(lastGreenSnapshot, current)` where the snapshot is the file named in `last-green.json`; if that file or its snapshot is missing it is `null` everywhere.
- The A9001 collapser lives in `check`, not in `build`, because it needs the diff and the tsc program; keep it in `packages/compiler/src/check/tsc-collapse.ts` so the CLI and MCP share it.
