# @averri/core

The public declaration API of Averri: seven constructs, two builders, one config helper.

```ts
import { entity, policy, action, query, event, workflow, integration, e, db, defineConfig } from "@averri/core";
```

Normative specs: `docs/SPEC-DECLARATIONS.md` (constructs, modes, key order, config) and `docs/SPEC-CONTRACTS.md` (the `e.*` / `db.*` tiers). Types live in `src/types.ts`; the runtime in the sibling modules.

## What the runtime does

- **Constructors** (`entity`, `policy`, `action`, `query`, `event`, `workflow`, `integration`) validate their options at call time (unknown option names, literal unions, `policy` XOR `public: true`, `run` XOR `handler`, `route` required in observe mode, `subject` required for `self`/`old` refs, phase/root rules, clause-name grammar) and return a **frozen plain object** `{ kind, id | name, mode?, options }` (events also carry `id: "Event:<Name>"`). Errors are `AverriDeclarationError` with `construct`, `id` and `option` fields.
- Every declaration carries a **non-enumerable `__averri` marker** (`AVERRI_MARKER`) with the IR node id and the lowered contract records (`ContractRecord[]`: id, phase, clause, tier, `expr` AST or `guard` function). Read it with `averriMeta(decl)`; test with `isDeclaration(x)`. The marker is invisible to `JSON.stringify`, `Object.keys` and deep equality, so the enumerable surface is exactly the typed shape and the compiler's static lowering is unaffected.
- **Builders** `e` and `db` produce the serializable AST from `@averri/ir`: bare left-hand paths are root-qualified (`"status"` → `self.status`), right-hand strings are literals, nested `where` objects are flattened to dotted keys (D-3), node keys follow the canonical order, and everything is frozen.
- **`defineConfig`** fills the documented defaults (`CONFIG_DEFAULTS`), validates (including the mandatory `actors.anonymous: { actor: null }`) and freezes.
- **Constants**: `PHASES`, `PHASE_FAILURE`, `AUTHENTICATION_FAILURE`, `SUCCESS_STATUS`, `CANONICAL_KEY_ORDER` (+ `CANONICAL_KEY_ORDERS` per construct, used by `averri fmt`), the literal lists (`EFFECT_VALUES`, `HTTP_METHOD_VALUES`, ...), `PHASE_ROOTS`.
- **Helpers** for `@averri/contracts`: `tierOf(clause)`, `isGuard`, `isAnalysableClause`, `flattenWhere`, `normalisePath`, `collectRefs`, `containsDbOp`, `containsEmitted`.

No registry, no import-time side effects (D-2). Runtime dependencies: none besides `zod` as a peer; `@averri/ir` is imported for types only.

## Tests

`npx vitest run packages/core` — builders, declarations, config and the type-level contract in `test/tier-types.test.ts` (checked by the root `typecheck`).
