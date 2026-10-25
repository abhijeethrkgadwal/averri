# @averri/compiler

The Averri build pipeline and graph services (ARCHITECTURE §1/§3). It never imports or evaluates a
user module (D-2): declarations and `averri.config.ts` are lowered statically with ts-morph.

```
extract (@averri/extract) → lower declarations + config → verify → rules → generated Test nodes
→ dependsOn + health → canonical graph → .averri/graph.json (+ snapshot, openapi.json, cards)
```

## Main entry points

```ts
import { build, loadOrBuild, impactQuery, check, explain, overview, find, inspect } from "@averri/compiler";

const graph = await loadOrBuild(root);                 // cached by contentHash, rebuilt when stale, never served stale
const { graph, generated } = build(root, { writeTests: true });   // `averri build`: also writes tests/averri/*.gen.test.ts
overview(graph); find(graph, { query: "invite" }); inspect(graph, { id: "Team.inviteMember" });
impactQuery(graph, { id: "Entity:Invitation" });       // or { diff }, { base }, {}
await check(root, { scope: "affected" });              // tsc (cascade-collapsed) + Vitest → diagnostics, last-check/last-green
explain(graph, { testId }) / ({ diagId }) / ({ diag: { code, node } }) / ({ traceId });
```

- **Verifiers**: route-match, effect-scan (SPEC-IR §3.1, interprocedural to depth 3), emit-scan,
  zod-match, consumer-scan, test-link. A declared node becomes `verified` only when every applicable
  verifier passed (D-9).
- **Rules**: one module per code under `src/rules/` (S1–S7). Deterministic fixes are unified diffs,
  dry-run applied before they are attached. tsc/Vitest backstops (A9001/A9002) live in `src/check/`.
- **Cache** (`.averri/`): `graph.json`, `build.lock`, `snapshots/<contentHash>.json` (LRU 20, last green
  pinned), `last-check.json`, `last-green.json`, `openapi.json`, `cards/<encodeURIComponent(id)>.md`.
- **Budgets**: overview 1 200, find 800, inspect 2 000, impact 1 500, check 2 000, explain 1 500 tokens
  (`ceil(chars / 4)`), truncated at item boundaries with `more` handles.

Decisions the specs leave open are recorded in `docs/SPEC-DECISIONS.md` (D-38).

## Tests

`npx vitest run packages/compiler` — fixture projects under `test/fixtures/` (`team-app` exercises one
mistake per rule; `seed-mini` is a copy of the seed app's declaration modules) are copied to
`test/.tmp/` per test file. `UPDATE_GOLDEN=1` rewrites `test/golden/*.json`.
