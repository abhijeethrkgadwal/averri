# SPEC-CONTRACTS — The three-tier contract language

Status: normative for V0. Types: `packages/ir/src/types.ts` §3 (AST) and `packages/core/src/types.ts` §3–6 (builders). Implemented by `@averri/core` (builders), `@averri/contracts` (evaluation), `@averri/testgen` (test derivation), `@averri/compiler` (checks, tier derivation, weakening rule). Decisions that deviate from the FINAL design document are logged in `SPEC-DECISIONS.md` and referenced as `D-n`.

## 1. Why three tiers

A contract written as an opaque lambda cannot be turned into a fast-check arbitrary, an auth matrix, an impact edge, or an actual-vs-expected report. A contract language with arbitrary expressivity cannot be evaluated in bounded time or compiled to SQL later. Averri therefore has exactly three tiers, each with a different TypeScript type, so tsc and the spec card both show which tier a clause is in:

| Tier | Written as | Type | Serialised | Test generation | Static impact | Runtime |
|---|---|---|---|---|---|---|
| 1 expression | `e.*` only | `ExprClause` | yes | violating arbitrary per clause; property for ensures | yes | pure evaluation over input/result/actor/self/old |
| 2 predicate | contains ≥1 `db.*` | `PredicateClause` | yes | fixture generator per predicate | yes (reads edges) | one Prisma `count` per predicate |
| 3 guard | a bare async function `async (ctx) => boolean` | `GuardFn` | no (opaque) | none | none | traced call |

There is no `guard()` wrapper (D-1): a call expression is not context-sensitive in TypeScript, so a wrapped lambda could never receive the action's input type; a bare function is deferred by tsc exactly like `run` and gets typed `input`/`actor`. The builders `e.and`/`e.or`/`e.not` accept only `AnalysableClause`, so a function cannot be mixed into an analysable clause (tsc error), and the runtime discriminates by `typeof clause === "function"`.

The compiler counts guards; `overview` reports `opaqueGuards / contracts`.

## 2. Reference roots and phases

A reference is `{ ref: "<root>.<path>" }` with root in `input | result | actor | self | old` and a dotted path of 1–3 segments (A3004 above 3).

| Root | Denotes | requires | ensures | invariant | policy allow |
|---|---|---|---|---|---|
| `input` | validated input (Zod output) | yes | yes | no | yes |
| `actor` | authenticated principal | yes | yes | no | yes |
| `self` | subject row: before `run` in requires, after `run` in ensures; the written row in invariants | yes* | yes* | yes (bare) | no |
| `old` | subject row before `run` | no | yes* | no | no |
| `result` | value returned by `run` / parsed response body in observe mode | no | yes | no | no |

\* only when the action declares `subject`; otherwise A3001. Using a root outside its column is A3003; so is `e.emitted` outside `ensures` (folded into A3003, no separate code).

**The one-line rule.** On the **left** of a comparison a string is a path (a bare field name means `self.<field>`; inside `invariant` it means the row). On the **right**, strings are always literals; use `e.input()`, `e.actor()`, `e.self()`, `e.old()`, `e.result()` to reference.

```ts
e.eq("result.email", e.input("email"))  // lhs path, rhs ref
e.eq("result.status", "pending")        // lhs path, rhs literal
e.ne("status", "pending")               // invariant: bare = row field
e.eq("input.email", "result.email")     // TYPE ERROR (NoRefString) and A3007: looks like a reference
```

**Deviation from FINAL §4 ("tsc checks field names against generated types").** tsc does not check field names or roots. `Path` is `RefPath | (string & {})`, which gives autocomplete for the five roots and accepts bare names; all field checking is the compiler's: A3002 (unknown field), A3003 (root/phase), A3010 (a bare first segment within edit distance 2 of a root, e.g. `"reslt.email"`, with a deterministic fix to the closest root). A doubled prefix such as `e.input("input.teamId")` is not normalised by the builder; it is A3002 with a deterministic fix that strips the duplicate root. Ref-shaped string literals on the right are rejected by the `NoRefString` type and, for strings tsc cannot see through (variables, template literals), by A3007 with a deterministic fix wrapping them in `e.<root>()`.

## 3. Tier derivation rule

The tier of a clause is a function of its value:

1. A function → `guard`. No AST is stored; `opaque: true`.
2. Otherwise, if any node in the AST has an `op` starting with `db.` → `predicate`.
3. Otherwise → `expr`.

Mixing analysable clauses is allowed: `e.and(e.eq("input.role", "member"), db.exists("team", { id: e.input("teamId") }))` is one `predicate` clause. The type system computes the same answer (`TierOf<>` in core; the executable check is `packages/core/test/tier-types.test.ts`). A guard MUST NOT be combined with `e.and`/`e.or`/`e.not`; the builders do not accept it.

## 4. Expression tier (`e.*`)

Boolean forms (clause roots):

| Builder | AST | Semantics |
|---|---|---|
| `e.eq/ne/lt/lte/gt/gte(lhs, rhs)` | `{op, lhs, rhs}` | JS strict comparison after normalisation: `Date` compared by epoch ms, `Decimal`/`BigInt` by numeric value, `null` only equal to `null`. `lt/lte/gt/gte` whose operands are not both numeric or both date-typed is A3008. |
| `e.and(...c)` / `e.or(...c)` | `{op, args}` | short-circuit left to right; at least one arg (type and schema enforce it) |
| `e.not(c)` | `{op: "not", arg}` | |
| `e.in(lhs, list)` | `{op: "in", lhs, rhs}` | membership; `rhs` is a literal list or a `RefValue` to a list field (never `e.sum/count`) |
| `e.isNull(path)` | `{op: "isNull", arg}` | true for `null` and `undefined` |
| `e.exists(path, where?)` | `{op: "exists", path, where?}` | over an owned list; inside `where` bare paths refer to the element |
| `e.emitted(Event, count?)` | `{op: "emitted", event, count?}` | ensures only; counts buffered emissions of this invocation; number = exactly, omitted = `{min: 1}` |

Value forms (operands):

| Builder | AST | Returns | Semantics |
|---|---|---|---|
| `e.input/actor/self/old/result(field)` | `{ref}` | `RefValue` | see §2 |
| `e.lit(v)` | `{lit}` | `ScalarValue` | explicit literal |
| `e.len(path)` | `{op: "len", arg}` | `ScalarValue` | string length or list length |
| `e.sum(path, field)` | `{op: "sum", path, field}` | `Value` | numeric sum over an owned list |
| `e.count(path, where?)` | `{op: "count", path, where?}` | `Value` | filtered element count |

`isNull`, `len`, `sum`, `count` and `exists` accept either a path string or a `RefValue`.

**Owned lists.** A path resolves to an owned list only if it denotes a Prisma relation field with `list: true` on the subject or result entity. How the list is available at evaluation time:

- Declared mode: when loading the subject the runtime `include`s every relation referenced by an owned-list op in any clause of the action (depth ≤ 3, nested includes for multi-segment paths). `result.<list>` is used only if the returned object carries it; otherwise it evaluates to `undefined` (comparisons false). Nothing else is loaded in V0.
- Observe mode: `self.<list>` is loaded the same way around the handler; `result.<list>` comes from the parsed response body only.

Evaluation is total: a missing field evaluates to `undefined`, comparisons with `undefined` are `false` (not an exception), and the trace records `evaluated` keyed by AST path (first failing leaf for `and`, all leaves for `or`) plus `undefinedRefs`. Evaluation MUST be O(size of the referenced values); no I/O.

## 5. Predicate tier (`db.*`)

| Builder | AST | Prisma compilation | True when |
|---|---|---|---|
| `db.exists(model, where)` | `{op: "db.exists", model, where}` | `count({ where }) > 0` | ≥ 1 row |
| `db.none(model, where)` | `{op: "db.none", ...}` | `count({ where }) === 0` | 0 rows |
| `db.unique(model, where)` | `{op: "db.unique", ...}` | `count({ where }) === 1` | exactly 1 row |
| `db.countWhere(model, where)` | `{op: "db.countWhere", ...}` (value) | `count({ where })` | used in a comparison |

**`where` is a literal clause in canonical flat form (D-3).** Keys are field names or dotted relation paths (`"user.email"`, depth ≤ 3). The source form may nest objects (`user: { email: ... }`); the **builder** flattens them, so the runtime value, the IR and the test generator share one representation. Values are refs, literals, or exactly one of `{in}`, `{not}`, `{lt}`, `{lte}`, `{gt}`, `{gte}`; operator operands are `ScalarValue | LitScalar` (refs, literals, `e.len()`), evaluated to scalars before the Prisma call. No `OR`, no `some/every/none` quantifiers, no raw SQL.

Relation rules: a dotted key may traverse only to-one relations (Prisma nested `where` on a to-one relation is `{ user: { email } }`). A segment that crosses a `list: true` relation is A3009 ("where path crosses a list relation; no quantifier in V0"), as is `e.sum`, `e.count` or `db.countWhere` nested inside a `where`. `model` MUST be a Prisma client accessor name (A1003) and every key MUST resolve to a field (A3002). A field literally named `in`, `not`, `lt`, `lte`, `gt`, `gte` is unsupported (same limitation as Prisma) and A3002.

**Un-flattening at runtime.** `@averri/contracts` turns `{ "user.email": {ref}, teamId: {ref}, role: { in: {lit} } }` into `{ user: { email: v1 }, teamId: v2, role: { in: [...] } }` while substituting refs; `{not: x}` → `{ not: x }`, `{lt: x}` → `{ lt: x }` etc.

**Undefined-ref rule (fail closed).** Prisma ignores `undefined` filter values, which would turn `db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"), role: { in: [...] } })` into "is a member of anything" for an anonymous actor. Therefore: if any ref in a `where` (or in an operator operand) evaluates to `undefined`, the predicate is `false` for `db.exists`, `db.unique` **and** `db.none`, and the whole clause is `false` when it contains a skipped `db.countWhere` (D-41a: a `0` would let `lte(count, n)` pass); the same holds when a Prisma call throws, and for a ref that is `undefined` underneath `e.not`, so negation can never turn a fail-closed `false` into a pass; the PhaseRecord carries `undefinedRefs: RefPath[]`; the Prisma call is skipped. Independently, the `authorize` phase with `actor === null` on a non-public declaration short-circuits to `401 Unauthenticated` before any policy is evaluated. The fixture test for exactly this case is mandatory (§10).

Predicates run inside the action's transaction in declared mode (so they see the same snapshot as `run`); in observe mode `requires` predicates run against the test database before the handler and `ensures` predicates after it. Each predicate contributes a `reads -> Entity:<Model>` edge with provenance `declared`; predicate reads never require `db:read` in `effects` (A4002 looks at the body only).

## 6. Guard tier (bare async function)

```ts
requires: { emailDomainAllowed: async ({ input, actor, self, old, result, prisma }) => boolean }
```

- `input` is `z.output<typeof input>`; `actor` is `Actor` under a policy and `Actor | null` when `public: true`; `self`/`old` are present only with `subject`; `result` is present only in `ensures` and is typed `unknown` there (D-18: typing it from `run` would fix the action's output type before `run` is inferred); `prisma` is the **non-transactional** client.
- `fn` MUST be side-effect free with respect to the application database; writes inside guards are not detected in V0 and are documented as forbidden. Guards MUST NOT do slow I/O: they run while the action's interactive transaction is open (Prisma default timeout 5 s; see `transaction: { timeout }`).
- Guards are evaluated in the same phase as other clauses, after all tier 1/2 clauses of the same phase.
- The spec card lists a guard as `opaque guard`, no test is generated, impact ignores its body, and `explain` reports only pass/fail and duration.
- A3005 (warning) fires when the guard body is a single return of a comparison over `input`/`actor`/`self` fields or a single `prisma.<model>.count/findFirst` call with a literal where — i.e. when a tier 1/2 form exists. The warning carries the suggested replacement as text, never as an applied fix.
- A guard as `policy.allow` is A2106 (warning): the auth matrix for its actions is not derivable.

## 7. Weakening rule (used by `impact`, history, PR bot)

Given a Contract at base `B` and head `H` with the same id:

- Removing a `requires` or `allow` clause, or replacing a tier 1/2 clause with a guard, is **weakening**. Removing an `ensures` or `invariant` clause is **weakening** (fewer guarantees). Adding a clause is `add-contract` (strengthening for every phase).
- For tier 1/2 → tier 1/2 edits the decision is syntactic. Direction depends on phase: for `requires`/`allow`, "admits more inputs/actors" is weakening; for `ensures`/`invariant`, "admits more states" is weakening. The per-node rules, applied recursively through `and`/`or`/`not` (a `not` flips polarity):

| Node | Edit | Effect on the set of satisfying states |
|---|---|---|
| `and` | drop a conjunct / add a conjunct | admits more / admits fewer |
| `or` | add a disjunct / drop a disjunct | admits more / admits fewer |
| comparison | `lt N → lt M` (M > N), `lte`, `gt N → gt M` (M < N), `gte` likewise | admits more |
| `in` | list grows / shrinks | admits more / fewer |
| `eq`/`ne` constant change | — | undecided (`change`) |
| `db.exists` / `db.unique` / `db.countWhere` | remove a `where` key / add a key; `in` list grows / shrinks; `lt N → lt M` (M > N) | admits more / fewer |
| `db.none` | the reverse of the row above (a weaker filter makes `none` harder to satisfy) | |
| `emitted` | `count` range widens / narrows | admits more / fewer |

"Admits more" is weakening for `requires`/`allow` and for `ensures`/`invariant` alike (both are satisfied by more states); the phase only determines who benefits. Anything not covered is `change` (undecided). Undecided changes to `requires`/`allow`/`ensures` MUST be flagged as "review: contract changed" by the PR bot and surface in `check.contractsWeakened` with `op: "change"`; they are never silently green.

## 8. Runtime behaviour per mode

**Declared mode** (`run`). Owned by `@averri/contracts`; one pipeline, written identically in SPEC-DECLARATIONS §5.3 and core `ActionContext` docs:

```
validate (Zod)                             → 400 ValidationFailed
authorize (plain client)                   → 401 Unauthenticated when actor === null and not public
                                           → 403 Forbidden on policy denial (contract: "Policy:<id>")
[tx begin]                                   when transaction !== false (Prisma interactive tx; timeout/maxWait passthrough)
  load self (+ include relations used by owned-list ops), snapshot old
  requires                                 → 412 PreconditionFailed (all clauses evaluated; tier 1, tier 2, then guards;
                                              guards receive the PLAIN client; first failure determines the response)
  run(ctx)                                 → 500 HandlerError on throw (tx rolled back)
  reload self
  ensures (+ invariants of the subject entity and of `result` when output is an entity)
                                           → 500 PostconditionFailed (tx rolled back)
[tx commit]
emit buffered events                        → trace-only EmitFailed; response stays 2xx (D-12)
```

Success returns `200` (adapter `status` may override) with the serialised result (`Date` → ISO string, `Decimal`/`BigInt` → string, `undefined` dropped). With `transaction: false` the same order runs on the plain client; an `ensures` failure cannot roll back, so the 500 body and the trace carry `committed: true`. In production, `requires` and `allow` are always on; `ensures` and invariants follow `config.sampling` (default 100% in dev/test, 0% in prod until configured).

**Observe mode** (no `run`). Nothing runs outside Vitest. `observe(app, { declarations, config })` wraps at the **fetch boundary**: for Hono it calls `app.fetch(request)`; for Express it serves the app with `http.createServer(app)` on an ephemeral port for the test file. Middleware registration order is irrelevant because nothing is registered. For each request Averri matches method and path against the declared `route` templates with its own matcher (SPEC-IR §4.1 normalisation) and, on a match:

1. `validate`: parses `input` = `{ ...body|query, ...params }` with the declared Zod schema (400 is recorded, the request still goes to the app);
2. `authorize`: recorded with `observed: true`; the decision is the app's own `401/403` vs 2xx, read after the response; Averri also evaluates the policy AST against the fixture's `actor` so the test can compare the two;
3. before the handler: `findFirst(subject.where)` for `self`/`old`; `findMany` for every entity with invariants (test database only); `requires` tier 1/2 evaluated, guards called with the plain client;
4. the real handler runs;
5. after: subject reloaded, invariant entities re-read and diffed by `@id`; `ensures` evaluated with `result` = parsed JSON body (only when status is 2xx), `emitted` = calls captured by a spy on `config.emitter.spy`.

The `handler:` option is used ONLY by `effect-scan`, line counting and the A2101 fix, never for interception. One `ActionTrace` is recorded per request with `test: { file, title }` from Vitest.

## 9. Test derivation (what `@averri/testgen` MUST produce)

Generated `it()` titles embed the ids so Vitest JSON output joins back to the graph: `"[Test:gen/Team.inviteMember.precondition] [Contract:Team.inviteMember.requires.notAlreadyMember] violation is rejected"`.

| Source | Generated test | Declared-mode assertion | Observe-mode assertion | Suite id |
|---|---|---|---|---|
| Action/Query with `policy` (tier 1/2) | one request per actor fixture in `config.actors`; expected allow/deny is computed AT TEST TIME by evaluating the policy AST against each fixture's `actor` via `@averri/contracts` | `403 Forbidden` + `Policy:<id>` on deny, `401` for `anonymous`, non-4xx on allow (a wiring check: the pipeline evaluates the same AST) | status ∈ {401, 403} on deny, 2xx on allow (the meaningful case: the app's own middleware is tested against the declared policy) | `auth-matrix` |
| `policy` is a guard | `it.todo` naming the policy | — | — | `auth-matrix` |
| each tier 1 `requires` | an arbitrary violating exactly that clause (others satisfied); one satisfying all clauses | violation → `412` + Contract id; satisfying → not 412 | violation → status ∉ 2xx and the trace's `requires` PhaseRecord for that contract has `ok: false`; satisfying → 2xx | `precondition` |
| each tier 2 `requires` | fixtures making the predicate false/true (algorithm below) | same | same | `precondition` |
| each tier 1 `ensures` | `fc.asyncProperty(validInput, …)` asserting the clause over the result | clause true on the 2xx result | same | `postcondition` |
| each `emitted` | exactly-N emission assertion | buffered emissions | spy calls | `event` |
| each Event with a Workflow | consumer-exists assertion (runner registered for `eventNamePrefix + name`) | same | same | `consumer` |
| each entity `invariant` | assertion after every generated write; property "1–5 generated actions preserve it" | on reloaded rows | on the `findMany` diff | `invariant` |
| `integration.webhook` with `scheme ≠ custom` | post a validly signed body (secret from `secretEnv`) asserting 2xx; post a tampered body asserting rejection | same | same | `pitfall.webhook-signature` |
| `integration.webhook.rawBody: true` | post a validly signed body with non-canonical whitespace/key order and assert 2xx (catches handlers that re-serialise parsed JSON before verifying) | same | same | `pitfall.raw-body` |
| `integration.webhook` with `scheme: "custom"` | tampered-body rejection only | same | same | `pitfall.webhook-signature` |
| `idempotency` or webhook | deliver twice with the same key; assert **single effect** = the after-snapshots (`findMany` ordered by `@id`) of every table in `effects.verified.writes` are identical after the first and the second delivery, and the second response is not 5xx | same | same | `pitfall.idempotency` |
| guards | nothing | — | — | — |

**Fixture synthesis for tier 2 predicates.** For a predicate over `model` with `where`: build the row that satisfies `where` by assigning refs from the generated input/actor and literals as given; for every required (non-optional, non-defaulted) field not in `where`, draw a fast-check arbitrary per scalar type (`String` → non-empty alphanumeric, `Int` → int, `DateTime` → recent date, `Boolean`, enums → sample of `values`, `Decimal`/`Float` → finite number, `BigInt` → bigint); walk required to-one relations to depth 3 creating parents first; respect `uniques` by drawing until unique within the test; the falsifying fixture is the same row with one `where` key altered (`eq` → different value, `in` → not-in sample, `not` → the excluded value, range → out of range). Fallback: `it.todo(reason)` for relation cycles, `Json`, `Bytes`, `unsupported` fields, or `where` keys on list relations.

Generated files live in `<config.test.generatedDir>/<owner>.gen.test.ts` with a `// @generated by averri <version> from <id> hash:<sourceHash> — do not edit` header and are regenerated only on `sourceHash` change (SPEC-IR §4, D-13).

## 10. Implementation notes

- **`@averri/core`**: builders construct AST objects and freeze them. `e.*` never inspects functions. Bare-path normalisation (`"status"` → `self.status`) happens in the builder so the AST is always root-qualified. Nested `where` objects are flattened in the builder (D-3). No import-time side effects.
- **`@averri/compiler`**: implements S3001–A3010, tier derivation, `reads` edges from predicates, and the weakening rule. Field checks use the Prisma schema facts for `self/old` roots and `where` keys, the TypeChecker type of `z.output<typeof schema>` for `input` (never the runtime `shape`), the declared `output` for `result`, and the augmented `Actor` type (via ts-morph type text) for `actor` when available, else skip.
- **`@averri/contracts`**: one evaluator for tier 1 over plain objects, one compiler from `db.*` to `prisma[model].count` with un-flattening and the undefined-ref rule, one guard runner; all three record `PhaseRecord`s. Observe-mode adapter for Hono (`fetch`) and Express (ephemeral server). Mandatory fixture tests: (a) anonymous actor against the `OwnerOrAdmin` policy returns 401 and the policy is never evaluated; (b) a `db.exists` whose `userId: e.actor("id")` is `undefined` evaluates to `false` with `undefinedRefs: ["actor.id"]` and performs no Prisma call; (c) the same for `db.none` (false, not true).
- **`@averri/testgen`**: arbitraries per Zod type via `fast-check`; the violating arbitrary for a clause is derived by negating the root comparison (`eq` → `ne` value, `lt N` → `>= N`, `in list` → not-in sample, `isNull` → non-null sample, `and` → violate one conjunct, `or` → violate all). Emits titles with the id prefixes above and reads `expect.getState().currentTestName` in the observe wrapper to fill `ActionTrace.test`.
