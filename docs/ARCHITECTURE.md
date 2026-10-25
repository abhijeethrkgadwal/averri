# ARCHITECTURE — Averri V0

Averri is an Apache-2.0 contract and semantic-graph layer for agent-written TypeScript backends on Prisma + Hono/Express + Zod. It started as "AgentLang" (a new language), was briefly working-named "Warrant" (collides with a WorkOS product), and landed on Averri: no new syntax, a compiler-maintained Semantic IR exposed through a small TypeScript declaration library, an MCP/CLI, generated tests and a public benchmark. The reasoning is in `docs/research/00-FINAL-strategy-and-design.md`; the normative specs are `docs/SPEC-*.md`; deviations and review decisions are in `docs/SPEC-DECISIONS.md`.

## 1. Packages and responsibilities

| Package | npm name | Responsibility | May import |
|---|---|---|---|
| `packages/ir` | `@averri/ir` | Semantic IR types, contract AST, Diagnostic types and code registry, zod schemas, pure helpers (ids, file-safe id encoding, tier, sort, validate, diff). No IO. | `zod` |
| `packages/core` | `@averri/core` | Public declaration API: `entity, policy, action, query, event, workflow, integration, e, db`, `defineConfig`; builders produce the IR contract AST (flat `where`); runtime-facing shapes (`ActionContext`, `ActionTrace`, `PHASE_FAILURE`, adapter and observe signatures, `AverriConfig`). No import-time side effects, no registry. | `@averri/ir` (types only), `zod` (peer) |
| `packages/extract` | `@averri/extract` | Extractors: Prisma schema facts (`@mrleebo/prisma-ast`) → Entity/Field; Hono/Express → Exposure (mount tree, middleware attribution, confidence); Zod → InputSpec via the TypeChecker; Vitest files → hand-written Test; Module nodes and content hash. Produces `extracted` nodes with evidence and confidence. | `@averri/ir`, `ts-morph`, `@mrleebo/prisma-ast`, `fast-glob` |
| `packages/compiler` | `@averri/compiler` | Build pipeline: run extractors, lower `@averri/core` declarations and `averri.config.ts` STATICALLY with ts-morph (never evaluates user modules), verify (route-match, effect-scan, emit-scan, zod-match, consumer-scan, test-link), run rules (S1–S7), compute `dependsOn`, health, derive generated Test nodes, `graph.json` cache, `loadOrBuild`, `diff`, `impact`, `check` (tsc collapse + Vitest runner), spec cards, OpenAPI. | `@averri/extract`, `@averri/ir`, `@averri/testgen`, `ts-morph`, `zod` |
| `packages/contracts` | `@averri/contracts` | Runtime: tier 1 evaluator, `db.*` → Prisma compiler (un-flatten, fail-closed undefined refs), guard runner, declared-mode pipeline (`handle`), `toHono`/`toExpress` adapters, observe-mode Vitest wrapper (`observe`, fetch-boundary), trace recorder. | `@averri/core`, `@averri/ir` |
| `packages/testgen` | `@averri/testgen` | Generates `tests/averri/*.gen.test.ts` from the graph: auth matrix, precondition, postcondition, event, consumer, invariant, pitfall suites; fast-check arbitraries; fixture synthesis from schema facts; `@generated ... hash:` headers. | `@averri/ir`, `fast-check` (emitted into tests) |
| `packages/mcp` | `@averri/mcp` | MCP server (stdio + HTTP): the six tools, `read_source`, `suggest`, resources, envelope, budgets. | `@averri/compiler`, `@modelcontextprotocol/sdk` |
| `packages/cli` | `averri` (bin) | `averri init | build | check | docs | report | fmt | testgen | suggest | mcp | <tool> --json`. Same tool modules as mcp. | `@averri/compiler`, `@averri/mcp` (tool modules), `commander`, `picocolors` |
| `examples/seed-app` | — | Reference SaaS app (orgs, members, invites, RBAC, Stripe webhook) in Hono + Prisma, ~20 k LOC target, written by an external contractor for the benchmark. | app deps only; `@averri/core` once declarations are added |
| `bench` | — | AgentCodeBench harness: tasks, hidden suites, arms, scoring, pre-registration. | `@averri/cli` as a black box |

## 2. Dependency direction

```
            zod
             │
        @averri/ir  ◄──────────────┐
          ▲   ▲                    │ (types only)
          │   │                    │
 @averri/extract  @averri/testgen  @averri/core
          ▲          ▲                  ▲
          │          │                  │
          └──── @averri/compiler        └── @averri/contracts
                     ▲                           ▲
            ┌────────┴────────┐                  │
       @averri/mcp       @averri/cli      user application (+ tests)
```

Rules:

- `ir` depends on nothing but `zod`. It is the vocabulary every other package shares.
- `core` imports **types only** from `ir` (the contract AST, literal unions). A user application importing `@averri/core` therefore pulls no IR runtime. (The task brief wrote this edge as "core <- ir"; the chosen direction is core → ir because the task places the AST in `ir/src/types.ts`.)
- `extract` and `testgen` know nothing about `core`: they operate on the graph.
- `compiler` does **not** import `core` (D-2): lowering is static, so nothing in core is needed at build time, and importing it would pull the user's `zod` peer into the compiler process. `compiler` is the only package that knows `extract` and `testgen`. `mcp` and `cli` depend on `compiler` only.
- `contracts` is the only package shipped into the application's runtime path (declared mode) or test path (observe mode). It never imports `compiler`, `extract` or `ts-morph`.
- Cross-package imports use the package name (`@averri/ir`), resolved through workspace symlinks. Relative imports across packages are forbidden.

## 3. Data flow

```
repository ──► extract ──► extracted nodes/edges ─┐
                                                   ├─► lower declarations + config (ts-morph, static) ─► verify ─► rules ─► dependsOn/health ─► graph.json
declaration modules (@averri/core) ────────────────┘                                                                      │
                                                                                                                          ▼
                                   testgen ◄── graph ──► spec cards / OpenAPI ──► docs                         .averri/graph.json
                                      │
                                      ▼
                           tests/averri/*.gen.test.ts ──► Vitest ──► results ──► check ──► diagnostics + last-check + last-green
                                                                        ▲
                                            contracts (observe wrapper / declared pipeline) ──► traces ──► explain
```

1. **Build** (`loadOrBuild`): hash inputs (generated tests excluded); if stale, run extractors, lower declarations statically, run verifiers to upgrade `declared` → `verified` (all applicable verifiers must pass), run rules to produce diagnostics, derive generated Test nodes, compute `dependsOn` (propagation table) and health, sort, validate against `GraphSchema`, write `.averri/graph.json`.
2. **Query** (MCP/CLI tools): read the graph, answer within budget, attach the envelope (`commit`, `dirty`, `stale: false`).
3. **Generate** (`averri build`/`check` also run testgen): write generated tests only when `sourceHash` changed; delete files whose owner node disappeared. Generated tests are an output and never feed the content hash (D-13).
4. **Check**: build → tsc (collapsed) → Vitest on affected tests → merge into diagnostics → write `last-check.json`; when green write `last-green.json` pointing at the pinned snapshot.
5. **Runtime** (declared mode) and **observe** (test time): record one `ActionTrace` per invocation into `.averri/traces/<date>.<pid>.jsonl`; `explain` joins traces with the graph through `ActionTrace.test` and the id prefixes in generated test titles.
6. **Report** (PR bot, CI): `averri report --base main` builds at base and head, diffs, emits a JSON report (impact, coverage delta, weakened contracts, generated-test status). Only the report leaves the runner.

## 4. The `.averri/` cache layout

Gitignored (already in `.gitignore`). Rebuildable from source at any time; deleting it is always safe.

```
.averri/
  graph.json                       # Graph (SPEC-IR §6), validated by GraphSchema on read; the only build artefact tools consume
  build.lock                       # serialises concurrent builds (subagents); stale locks older than 60 s are broken
  last-check.json                  # { meta: { contentHash }, diagnostics, tests } from the last `check`; resolves `explain {diagId}`
  last-green.json                  # { meta: GraphMeta, tests, at, snapshot: "snapshots/<contentHash>.json" } written by a green `check`
  snapshots/<contentHash>.json     # Graph at a content state, for history/impact/report diffs; LRU-pruned to 20, the last-green one pinned
  traces/<YYYY-MM-DD>.<pid>.jsonl  # ActionTrace per line, one file per process (Vitest workers append concurrently); 7-day retention
  reports/<sha>.json               # output of `averri report`, kept for the CLI's human rendering
  openapi.json                     # derived OpenAPI document (regenerated every build)
  cards/<encodeURIComponent(NodeId)>.md   # spec cards (ids contain `:` and `/`; D-24); `averri docs` copies them into SPEC.md per module
```

Configuration lives outside the cache in `averri.config.ts` at the project root (`defineConfig` from `@averri/core`, typed `AverriConfig`; example in SPEC-DECLARATIONS §9): source roots, Prisma schema path, Prisma client fallback symbol, router entry points, actor fixtures (`anonymous` mandatory), emitter bridge/spy/prefix, public-route marker, auth middleware names, production sampling, test database env var and generated-tests directory. The compiler reads its static fields with ts-morph; `@averri/contracts` imports it at test time and runtime.

**Test database.** Generated tests and the observe wrapper use the database the project supplies through `process.env[config.test.databaseUrlEnv]` (default `DATABASE_URL`), typically a local Postgres or a testcontainers instance the project already uses. The FINAL doc's "pglite in-process by default" is not possible with Prisma without a driver adapter and is deferred to an opt-in adapter (D-6).

Note: the FINAL design document specified SQLite (better-sqlite3 + FTS5) for the graph and trace store. `better-sqlite3` is not among the installed dependencies, so V0 uses JSON validated by the zod schemas; the schema and the `.averri/` contract are unchanged, and SQLite is a drop-in storage upgrade behind `loadOrBuild` if `find` latency or trace volume require it.

## 5. What V0 does NOT do

- No new file format or syntax. Declarations are TypeScript; `.al` is a 2028 question gated on Stage 2 and a corpus.
- No application code generation: no routes, Prisma schema fragments, migrations, Zod schemas, consumers, or idempotency tables are emitted. Only tests, OpenAPI and spec cards. Idempotency is a declared fact driving a generated test and a lint (D-11).
- No evaluation of user code at build time: the compiler lowers declarations statically and never imports a project module (D-2).
- No IR patch language, no `apply_patch`, no projection printer. Agents edit TypeScript with their own tools; `check` validates.
- No hosted runtime, event bus, queue, durable-execution engine, cache, or rate limiter. `workflow` binds to Inngest/pg-boss/custom; `integration` wraps clients.
- No authentication. `actor` comes from the application's own middleware/session (adapters receive an `actor(req)` extractor).
- No ULIDs, no committed `ir.json`, no reconciliation. Ids are the declared strings; history is computed from two builds.
- No session-aware deltas, no `conventions` tool, no text search tool, no token-cost dashboard (an MCP server cannot see token counts).
- No root-cause analysis beyond the diff-scoped tsc cascade heuristic, described as such.
- No ORMs other than Prisma, no routers other than Hono and Express, no validators other than Zod, no test runner other than Vitest, no NestJS, no Python, no pglite.
- No dev-server middleware in observe mode: contracts run under Vitest only, at the fetch boundary. Declared mode is the only runtime path and ships after an external security review.
- No embeddings or semantic search in `find`; lexical and structural matching only.
- No counterfactual replay, failing-sequence minimisation, learned fix ranking, or primitive mining from agent logs.
- No Stage 2 (`fields`, `paginate`, `filter`, `sort`, `tenant` derivation, runtime idempotency, `averri fmt --write`) until the benchmark gate in FINAL §7 is passed.

## 6. Conventions

- Node 20, TypeScript 5.9 strict with `noUncheckedIndexedAccess`, ESM, NodeNext resolution, `.js` extensions on relative imports.
- LF line endings everywhere (`.gitattributes`, `.editorconfig`).
- Tests in `packages/<pkg>/test/**/*.test.ts` with Vitest (type-level contracts such as `packages/core/test/tier-types.test.ts` are checked by the root `typecheck`); generated application tests live in the target project under `tests/averri/` and are excluded from Averri's own Vitest config.
- Every normative statement in `docs/SPEC-*.md` MUST correspond to a type or a test. Spec changes and type changes land in the same commit. Deviations are logged in `docs/SPEC-DECISIONS.md` with a number that the specs cite.

## 7. Packaging

Each package builds with `tsc -b` (project references, `composite`; root `npm run build` uses `tsconfig.build.json`) to `packages/<pkg>/dist` (.js, .d.ts, source maps). `exports` has four conditions: `development` (`./src/index.ts`, used in-repo by the root tsconfig `customConditions`, Vitest `resolve.conditions` and `tsx --conditions=development`), `types`, `import` and `default` (`./dist/index.js`). A package `prepack` hook (`scripts/pack-hooks.mjs`) rebuilds, copies the root LICENSE in and strips `development` from the packed manifest, so consumers never see the source condition. The CLI `bin` is `dist/bin.js`; `npx -y @averri/cli mcp` is the registration `init` prints. Release procedure and the verified pack-and-install run: docs/RELEASING.md.
