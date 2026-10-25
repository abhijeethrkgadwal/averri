# @averri/testgen

Generates `tests/averri/<owner>.gen.test.ts` from the Semantic IR (SPEC-CONTRACTS §9). Pure: a function of
`(graph, options)` with no IO and no randomness, so the compiler owns writing, staleness (A6001) and
deletion of generated files. Depends on `@averri/ir` only; the emitted files import `vitest`, `fast-check`
and the test-harness surface of `@averri/contracts`.

## API

```ts
import { generateTests, planTests, deriveTestNodes, sourceHashOf, parseGeneratedHeader, isGeneratedTestStale } from "@averri/testgen";

generateTests(graph, { actors: ["anonymous", "member", "admin"], generatedDir: "tests/averri" });
// -> [{ path: "tests/averri/Team.inviteMember.gen.test.ts", content, hash, owner: "Action:Team.inviteMember", tests: ["Test:gen/Team.inviteMember.auth-matrix", ...] }, ...]

planTests(graph, options);        // the suites (future Test nodes) with covers, sourceHash and it.todo reasons
deriveTestNodes(graph, options);  // { nodes: TestNode[], edges: verifiedBy Edge[] } for the compiler to add to the graph
sourceHashOf(graph, ownerId);     // the `hash:` of the owner's file, computed from the graph alone
isGeneratedTestStale(testNode, fileContentOrNull); // A6001
```

Options (`GenerateOptions`): `generatedDir` (`config.test.generatedDir`, default `tests/averri`), `configFile`
(`averri.config.ts`), `entryPoint` (default `meta.stack.entryPoints[0]`), `actors` (fixture names from
`config.actors`; `anonymous` is always first), `numRuns` (10), `averriVersion`, `only` (Test or owner ids).

## What is generated

| Owner | Suites |
|---|---|
| Action / Query with `policy` | `auth-matrix`: one request per fixture; expected decision computed at test time by `h.policyDecision`; predicate policies get a second row per fixture with the predicate falsified |
| Action | `precondition` (a violating input per tier-1 clause, a falsifying fixture per tier-2 clause, one all-satisfied call), `postcondition` (`fc.asyncProperty` over the valid input), `event` (exactly-N / min / max), `pitfall.idempotency` |
| Entity with `invariant` | `invariant`: current rows + "1–5 generated writes preserve it" property over the entity's writers |
| Event with a Workflow | `consumer`: `h.consumerRegistered(event, workflow)` |
| Integration with `webhook` | `pitfall.webhook-signature` (signed body accepted, tampered body rejected; `custom` scheme: tampered only), `pitfall.raw-body`, `pitfall.idempotency` |

Declared and observe modes get different assertion columns (412 + Contract id vs non-2xx + trace record;
401/403 + Policy id vs status in {401, 403}; trace emit phase vs spy calls). Guards get no tests. Anything the
spec marks as non-derivable (guard policies, relation cycles, `Json`/`Bytes`/`Unsupported` fields, list-relation
`where` keys, `db.countWhere` fixtures, refs the generator cannot control) becomes `it.todo(reason)` and is listed
in `PlannedSuite.todos`.

## Fixture synthesis

For a predicate over `model` with a flat `where`, the emitted seed function builds the satisfying row (refs
from the generated input and the fixture's actor, literals as given), draws every other required field with
fast-check per Prisma type, creates required to-one parents first (depth <= 3, FK scalar found by the
`<relation>Id` convention, `ensureRow` when the FK value is pinned), and in `falsify` mode alters the first
`where` key (`eq` -> different value, `in` -> not-in sample, `not` -> the excluded value, range -> out of range).
`@unique` columns draw nonce-suffixed values instead of retrying.

## The harness the generated tests import

`src/harness-api.ts` is the surface `@averri/contracts` must export (`createTestHarness`, `AverriTestHarness`,
`PhaseLike`, `TraceLike`, `PrismaModelLike`). The typecheck test maps `@averri/contracts` onto this file and
runs `tsc` with `noUnusedLocals`/`noUnusedParameters` over the emitted files.

## Tests

`npx vitest run packages/testgen` — unit tests per module, property tests (emitted arbitraries are instantiated
with real fast-check and checked against an independent clause evaluator), golden files in `test/golden/`
(`UPDATE_GOLDEN=1` to accept), determinism under node/edge permutation, and the emitted-code typecheck.
