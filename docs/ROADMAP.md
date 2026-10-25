# Roadmap

This is a community open-source project with no revenue targets, no hiring plan, and no customers to sign. The milestones below are adapted from section 9 of [docs/research/00-FINAL-strategy-and-design.md](research/00-FINAL-strategy-and-design.md), which was written for a two-person funded company; everything about money, tiers, design partners, SOC 2, and headcount has been removed. What remains is the order in which the technical work has to happen and the demo that proves each step is done.

Dates are not promised. Milestones are. A milestone is complete when its demo criterion is met on the reference app, not when the code is merged.

## Governing idea

Build in the order that survives being wrong. The representation (contracts as verified graph facts) is the thing to prove; everything that depends on it being right (application codegen, a bespoke syntax) waits for the benchmark to say so. If the benchmark says no, what has been built is still useful: a declaration library, generated pitfall and auth-matrix tests, and a lint-grade impact report for PRs.

## V0: attach mode (the current milestone)

Scope: one ORM (Prisma), two routers (Hono, Express), one validator (Zod). No generated application code. Everything attaches to an existing repo.

### M1. Extract and declare

- `@averri/ir`: node and edge types, three provenance levels, serializable contract AST, SQLite store under `.averri/`, build-at-two-commits diff.
- `@averri/extract`: Prisma schema, Hono and Express static route registration (dynamic mounts become `Exposure` nodes with evidence), Zod schemas by reference.
- `@averri/core`: `entity`, `policy`, `action`, `query`, `event`, `workflow`, `integration`, `e`, `db`, `guard`, with literal-union option types.
- `@averri/compiler`: load declaration modules with ts-morph, lower to IR with source ranges, resolve declared routes against extracted ones, verify effects by scanning handlers for `tx.<model>` calls, emit structured diagnostics for the first ten codes with deterministic fixes.

Demo: `averri check` on `examples/seed-app` reports a graph with counts by node kind, flags an exposed route with no policy, and proposes the sibling policy as the fix, with a patch.

### M2. Observe mode and generated tests

- `@averri/contracts` observe mode: Vitest adapter wrapping the Hono app or Express router; `requires` and `ensures` evaluated from request and response bodies and DB before/after snapshots; test-time spy on the project's own emitter for `e.emitted`.
- `@averri/testgen`: auth matrix (anonymous / member / other-tenant / admin), precondition boundary tests with a violating arbitrary per expression clause, fast-check postcondition properties, event emission counts, pitfall tests (`integration("Stripe", { webhook: { verify, rawBody } })` posts a signed raw body; idempotency as a duplicate-delivery test).
- Generated tests written to `tests/averri/*.gen.test.ts` with `@generated` headers, content-hash writes, deletion when the node disappears.
- Trace recorder: one trace per action invocation in test and dev, SQLite under `.averri/`, never the application database.

Demo: the reference app's 30 actions carry declared contracts; `npm test` in the example runs the generated suite against pglite; breaking a `requires` turns exactly one generated test red and names the contract id.

### M3. Agent interface

- `@averri/mcp`: `overview`, `find`, `inspect`, `impact`, `check`, `explain`, plus `read_source` and `suggest`; token budgets per tool; content-hash rebuild on every call with `commit` and `stale: false` on every response; construct docs as MCP resources (`averri://docs/<construct>`).
- `@averri/cli`: `averri init` (detect stack, write config, write the CLAUDE.md / AGENTS.md / `.cursor/rules` block), `check`, `docs`, `fmt`, `suggest`, `mcp`, and `<tool> --json` mirrors.
- `averri docs`: deterministic Markdown spec card per action, under 15 lines, with `verified` vs `opaque` per clause.

Demo (the V0 exit criterion): a Claude Code session on the reference app adds a policy-protected endpoint using only Averri tools; `check` reports which generated tests cover it; `impact` names the dependents. A non-engineer reviews the change from spec-card diffs alone.

### M4. Internal benchmark run

- `bench/`: task definitions, arm configurations, hidden-suite runner, scoring, report generation.
- Twenty tasks on the reference app, four categories by five, with hidden HTTP-level acceptance tests and a hidden regression suite. Task selection targets a 40-70% baseline pass rate.
- Pilot run: arms A, A+lib, and B at small N on one pinned model, to find harness bugs and check that the effect is directional before anyone spends real money on N=10.

Gate: if B is not ahead of A+lib at all in the pilot, stop and rethink the representation before the public run. This gate is written down so it cannot be moved later.

## V0.5: prove

- `defineAction` mode: the opt-in refactored pipeline (validate, authorize, requires, tx, run, ensures, emit) using the project's own Prisma `$transaction`; `requires` always on, `ensures` sampled. A security review of `defineAction` and the policy evaluator by someone outside the core contributors precedes any tag that suggests production use.
- `suggest`: draft `intent` and contracts for undeclared handlers from Zod schemas, guards, and existing tests, returned as a diff.
- AgentCodeBench v0 run as pre-registered in [BENCHMARK.md](BENCHMARK.md): the frozen pre-registration posted publicly before the run, N=10 per cell, one pinned model, raw session logs published, losses published.
- Ten held-out tasks written after the primitive set is frozen.
- A third party invited to reproduce. Funding for runs is an open question answered in BENCHMARK.md; the harness is designed so that someone else can run it without us.

Gate (the kill criteria in BENCHMARK.md, verbatim): if B+ beats A by under 5 points pass@1 and under 15% iterations, with A+lib capturing most of whatever gain exists, the representation is not the product. The project then narrows to the declaration library, the generated tests, and the impact report, and Stage 2 is not started. If B captures most of B+'s gain, contracts are a governance feature, not a correctness one, and Stage 2 codegen is not started.

## Stage 2: declared mode with derivation (only if the gate clears)

Declarations gain `fields`, `paginate`, `filter`, `sort`, `tenant`; the compiler emits what the project already uses, not a second stack: Prisma schema fragments and migrations, Hono/Express routes, Zod schemas, OpenAPI, Inngest or pg-boss consumers for workflows. Generated files carry `@generated` headers; `averri check --clean` fails CI on drift; `averri eject` strips the headers and leaves a plain Prisma + Hono project, and that demo precedes the Stage 2 release. Benchmark arms C and D are added. None of this is designed in detail until the gate clears, on purpose.

## After that

A bespoke `.al` syntax as a third projection of the IR is a question for when (a) Stage 2 exists and (b) a public corpus of at least a few hundred Averri-annotated repos exists to teach it from. The project's own research says a new grammar before then pays the no-training-data tax in every context window forever. It is listed here so nobody has to ask whether it was forgotten.

Other items that are explicitly after V0 and not scheduled: a NestJS extractor; a Python/FastAPI extractor; a Drizzle extractor; production-trace export via OpenTelemetry (opt-in); counterfactual replay and failing-sequence minimisation in `explain`; mining agent interaction logs to propose new primitives.

## Non-goals

These are not "later." They are things the project has decided not to be, and a PR proposing one should expect to be declined with a pointer here and to [JOURNEY.md](JOURNEY.md).

- **A new programming language or file format in V0 or Stage 2.** Declarations are TypeScript. See JOURNEY.md for the Wasp, Darklang, and Keel precedents and the no-training-data argument.
- **A hosted runtime or a hosted graph.** The graph is a gitignored cache rebuildable in seconds; nothing you must host and nothing we host for you.
- **Reimplementing durable execution, authentication, or a database.** `workflow` binds to Temporal, Inngest, Restate, or pg-boss; `policy` is authorization only, and authentication stays with whatever the project uses; entities attach to the project's Prisma models.
- **A code-search or navigation product.** Frontier models navigate repos adequately and vendors give indexing away. `find` exists so agents can locate graph nodes, not to compete with grep.
- **A token-spend dashboard.** An MCP server cannot see token counts. We will not pretend otherwise.
- **An IR patch language for agents.** Agents edit text; `check` validates; `impact {diff}` is the pre-edit question.
- **Cascade root-cause analysis.** Cascade collapse is a diff-scoped heuristic and is described as one.
- **Confidence scores on fixes.** Fixes carry an `evidence` string. Fixes are offered only for codes whose repair is deterministic.
- **Generated application code in V0.** Tests, OpenAPI, and spec cards are derived; routes, schemas, and handlers are not, until the benchmark earns it.
- **A commercial plan inside this repository.** The research round designed Team and Enterprise tiers and a closed PR-bot server for a company that was not founded. This repo has no tiers. Everything here is Apache-2.0 and will stay that way. If someone later builds a hosted service on top of Averri, that is their project.
- **Supporting every stack.** One ORM, two routers, one validator in V0. Breadth is how a small project becomes a shallow one.

## How this document changes

Milestone contents change through spec PRs (see [CONTRIBUTING.md](../CONTRIBUTING.md)). The benchmark gates and the non-goals change only with a written rationale in the PR that references the research they contradict, so the project cannot quietly talk itself out of its own disconfirmation tests.
