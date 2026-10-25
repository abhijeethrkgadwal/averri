# @averri/contracts

The Averri runtime. It is the only package shipped into an application's request path (declared mode) or
test path (observe mode). Normative specs: `docs/SPEC-CONTRACTS.md` (evaluation, §4–§8, §10) and
`docs/SPEC-DECLARATIONS.md` (§5.3 pipeline, §6 observe mode, §10). Deviations: `docs/SPEC-DECISIONS.md` D-36.

## What it contains

| Module | Exports | Role |
|---|---|---|
| `evaluator` | `evaluateExpr`, `evaluateOperand`, `evaluateClause` | Tier-1 evaluator over `{ input, result, actor, self, old, emitted }`. Total, no I/O, fail-closed on undefined refs, `evaluated` keyed by AST path. `evaluateClause` adds tier 2 by pre-fetching one `count` per `db.*` node. |
| `predicates` | `compileWhere`, `unflattenWhere`, `evaluateDbNode`, `prefetchDbNodes`, `predicateHolds`, `modelOf` | `db.exists/none/unique/countWhere` → `prisma[model].count({ where })`; flat `where` un-flattened; any undefined ref ⇒ `false`/`0` and **no Prisma call**. |
| `guards` | `runGuard` | Tier-3 runner: plain client, duration, throw/non-boolean ⇒ failed. |
| `contracts` | `evaluatePhase`, `evaluateContract`, `evaluateInvariants`, `evaluatePolicy`, `orderByTier` | `PhaseRecord`s over the `ContractRecord`s in a declaration's `__averri` marker; order expr → predicate → guard; every clause evaluated, first failure reported. `evaluatePolicy` is what generated auth-matrix tests call at test time. |
| `pipeline` | `invoke`, `handle`, `PhaseFailure`, `countingClient`, `includeTree` | The declared-mode order validate → authorize → `[tx` load self → requires → run → reload → ensures + invariants `]` → emit, with `PHASE_FAILURE` statuses, `ContractViolationBody`, `committed` semantics and one `ActionTrace` per call. |
| `adapters` / `runtime` | `toHono`, `toExpress`, `createRuntime` | Framework adapters (input `{ ...(GET ? query : body), ...params }`, path params win, status 200 default) and the core-typed `DeclaredRuntime`. |
| `matcher` / `observe` | `observe`, `matchRoute`, `normaliseRoutePath`, `installEmitterSpy` | Vitest-only fetch-boundary wrapper: Hono via `app.fetch`, Express via an ephemeral `http.createServer`; subject/invariant snapshots through the project's Prisma client; emitted events via a spy on `config.emitter.spy`. |
| `trace` | `createTraceRecorder`, `memoryTraceRecorder`, `readTraceFile`, `pruneTraces`, `currentVitestTest` | JSONL recorder, `.averri/traces/<YYYY-MM-DD>.<pid>.jsonl`, 7-day retention. |

## Declared mode

```ts
import { toHono, createRuntime } from "@averri/contracts";
import { prisma } from "./db";
import config from "../averri.config";
import { InviteMember, Invitation } from "./members/inviteMember";

app.post("/teams/:teamId/invitations", toHono(InviteMember, { actor: (c) => c.get("user") ?? null, prisma, config, declarations: [Invitation] }));

// or bind once
const runtime = createRuntime({ prisma, config, declarations: [Invitation] });
app.post("/teams/:teamId/invitations", runtime.toHono(InviteMember, { actor: (c) => c.get("user") ?? null }));
const result = await runtime.handle(InviteMember)(input, actor); // { status, body, trace }
```

`declarations` is only needed to resolve entity **names** (`subject.entity: "Invitation"`, `output: "Invitation"`)
to their invariants; entity declarations passed by reference need nothing. `recorder: null` disables trace files
(tests); `recorder` defaults to the process-wide file recorder.

## Observe mode (Vitest)

```ts
const averri = await observe(app, { declarations, config, prisma });
const { status, body, trace } = await averri.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { email, role } });
await averri.close();
```

`trace.phases` carries two `authorize` records: Averri's evaluation of the policy AST (`observed: false`) and the
app's own decision read from the status (`observed: true`). `requires`/`ensures` are evaluated only when the
declared schema accepts the input; entities with invariants are re-read and diffed by `id` after every request.
When the emitter spy sees events, an `emit` record follows `run`. A 404 counts as the app's denial when the
declared policy denies.

## Generated-test harness

`createTestHarness({ config, app, modules, prisma? })` is what `tests/averri/*.gen.test.ts` import (the surface is
fixed by `packages/testgen/src/harness-api.ts`). It resolves declarations by id from the given modules, drives
observe-mode actions through `observe()` (path params from the input, the rest as query or JSON body, webhook
routes signed with the declared scheme) and declared ones through `invoke()`, and exposes `policyDecision`,
`parseInput`/`conformInput` (schema-guided input repair, `src/zod-sample.ts`), `snapshot`, `emitted`,
`consumerRegistered` and `invariantViolations`. See D-40.

## Tests

`npx vitest run packages/contracts` — unit tests use `test/helpers/fake-prisma.ts`, an in-memory client shaped
like Prisma (`count/findMany/findFirst/create/update/upsert/delete`, `$transaction` with rollback on throw, a call
log). Integration tests use real Hono (`app.request`) and Express (supertest, and the ephemeral server in observe mode).
