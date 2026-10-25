# Contributing to Averri

Averri is pre-alpha. The design is settled enough to build against; most of the code does not exist yet. That makes this a good moment to contribute and a bad moment to assume anything works. Read [docs/JOURNEY.md](docs/JOURNEY.md) first so you know what was deliberately left out and why; a large share of "why not add X" questions are answered there.

## Running the repo

Requirements: Node 20 or newer, npm 10 or newer, git. No global installs.

```sh
git clone <this repo> averri
cd averri
npm install            # installs the workspace; packages are linked, nothing is built
npm test               # vitest over packages/*/test, examples/*/test, bench/test
npm run typecheck      # tsc --noEmit over every package, example, and the bench
npm run averri -- --help   # runs the CLI from source via tsx
```

Packages are consumed from `src/` directly (every `package.json` points `main` at `src/index.ts`); there is no build step in development. Tests live next to the package they test, in `packages/<name>/test/*.test.ts`, and run under the root vitest config. `tests/averri/**` is excluded from vitest because that is where Averri writes *generated* tests into a user's project; the example app will have such a directory and it must not be picked up as the project's own suite.

## Package map

All packages are `@averri/<name>`, Apache-2.0, ESM, TypeScript 5.9, strict.

| Package | What it owns | Depends on |
|---|---|---|
| `packages/ir` | IR node and edge types, provenance (`extracted` / `declared` / `verified`), the serializable contract AST, the SQLite graph store, diff between two builds | nothing in-repo |
| `packages/core` | The declaration library users import: `entity`, `policy`, `action`, `query`, `event`, `workflow`, `integration`, `e`, `db`, `guard`. Branded literal-union option types. No runtime behaviour beyond building declaration objects | `ir` |
| `packages/extract` | ts-morph extractors: Prisma schema (via `@mrleebo/prisma-ast`), Hono and Express static route registration, Zod schemas by reference. Produces `extracted` nodes with evidence | `ir` |
| `packages/compiler` | Loads declaration modules, lowers them to IR with source ranges, resolves against extracted nodes, runs domain checks, emits structured diagnostics with deterministic fixes, verifies effects by scanning handlers for `tx.<model>` calls | `ir`, `core`, `extract` |
| `packages/contracts` | Runtime: `observe` mode (Vitest adapter around the Hono app or Express router) and `defineAction` mode (validate, authorize, requires, tx, run, ensures, emit). Expression and predicate evaluators. Trace recorder to `.averri/` | `ir`, `core` |
| `packages/testgen` | Generates Vitest suites from the IR: auth matrix, precondition boundaries, fast-check postcondition properties, event emission, pitfall tests. Writes `tests/averri/*.gen.test.ts` with `@generated` headers | `ir`, `contracts` |
| `packages/mcp` | The MCP server (stdio and HTTP): `overview`, `find`, `inspect`, `impact`, `check`, `explain`, plus `read_source` and `suggest`. Token budgets, content-hash rebuild, docs as MCP resources | `ir`, `compiler`, `testgen`, `contracts` |
| `packages/cli` | `averri` binary: `init`, `check`, `docs`, `fmt`, `suggest`, `mcp`, and `<tool> --json` mirrors of every MCP tool with identical output | everything above |
| `examples/seed-app` | The reference application (orgs, members, invites, RBAC, Stripe billing webhook) in Hono + Prisma + Zod. Also the benchmark's seed app | `core`, `contracts` |
| `bench` | AgentCodeBench harness: task definitions, arms, hidden-suite runner, scoring, report | `cli` |

Dependency direction is strictly downward in that table. If you find yourself importing `mcp` from `compiler`, stop and ask.

## Specs are normative; change the spec first

Averri's value depends on eight packages agreeing on the same types, semantics, and names. We keep that agreement in written specifications, not in whoever last edited a file.

- The normative specifications live under `docs/` and are listed from [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Until a dedicated spec file exists for a topic, sections 4 through 7 of [docs/research/00-FINAL-strategy-and-design.md](docs/research/00-FINAL-strategy-and-design.md) are the normative source for that topic (reading "Averri" wherever it says "Warrant").
- If a change alters a type that crosses a package boundary, a tool's input or output shape, a diagnostic code's meaning, the contract AST, the evaluation order of the action pipeline, the generated-test layout, or anything an agent or a user could observe, **open a PR against the spec first**. Say what changes, why, and what breaks. Code PRs that silently diverge from the spec will be asked to either update the spec in the same PR or conform.
- Spec PRs are small and argued. One change per PR. Link the research that motivates it if there is any, and say so plainly if there is not.
- Where the spec is silent, the implementation may choose, and the PR must add the choice to the spec. "The spec did not say" is a reason to extend the spec, not a licence to improvise twice in two packages.

## Coding conventions

These exist because the project's own research says a 0.x library has no training-data prior and agents (and people) will misremember it. Every rule below reduces the number of ways to say the same thing.

- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, ESM, `NodeNext` resolution. No `any` outside a test fixture; no `as` casts to silence the compiler where a type guard would do.
- **Every option is a literal union.** `effects: ["db:write", "event:emit"]`, not `effects: string[]`. `severity: "error" | "warning"`, not `severity: string`. If tsc can reject a hallucinated value, it must.
- **No string mini-DSLs.** No `"status in [draft, placed]"` strings parsed at runtime. Contracts are built with the `e.*` and `db.*` combinators, which produce a serializable AST that tsc has already checked. If a string is doing work that a type could do, it is a bug.
- **One construct per concept, one spelling.** No aliases, no sugar, no optional alternative key names. If `requires` exists, there is no `pre`. Fixed key order in declarations is enforced by `averri fmt`.
- **Honesty over confidence.** Diagnostics carry an `evidence` string, never a fabricated confidence number. Extracted nodes carry `evidence` and the tool refuses to answer below roughly 90% confidence rather than guess. Nothing in the project should say "root cause" where it means "diff-scoped heuristic."
- **Bounded output.** Every MCP tool and CLI `--json` response has a documented token budget. If you add a field, say what it costs.
- **Tests next to packages.** `packages/<name>/test/<topic>.test.ts`, vitest, fast-check where a property is the natural statement. A change to the compiler or testgen that changes generated output must update the golden fixtures in the same PR.
- **Generated files are marked.** Anything Averri writes into a user's project starts with `// @generated by averri <version> from <id> — do not edit` and is written only on content-hash change.
- **Files use LF line endings, two-space indent, UTF-8, trailing newline** (see `.editorconfig` and `.gitattributes`).
- **No new runtime dependencies without a spec PR.** The dependency list is a design decision, not a convenience.

Deviations are allowed when the spec is wrong; the way to deviate is the spec PR above.

## Pull requests

1. One logical change per PR, with a description that says what and why. Link the spec section you are implementing.
2. `npm test` and `npm run typecheck` pass locally.
3. New behaviour has a test; changed behaviour has a changed test.
4. Every commit is signed off (next section).
5. Be patient: this is a volunteer project and review may take days.

If you want to work on something substantial, open an issue first so two people do not build the same thing. Issues tagged `good first issue` are scoped to one package and one spec section.

## Developer Certificate of Origin

Averri uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a Contributor License Agreement. There is no CLA and there will not be one. By signing off a commit you certify that you wrote the change or otherwise have the right to submit it under the project's Apache-2.0 licence.

Sign off every commit:

```sh
git commit -s -m "compiler: verify writes edges from tx.<model> calls"
```

This appends a `Signed-off-by: Your Name <you@example.com>` line. Use a real name and an address you control. Unsigned commits will be asked to be amended; we will not merge them as-is.

The project will not relicense. The Apache-2.0 licence on this repo is the licence, now and later.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1). Report problems to the contact listed there.

## Where to start

- Read `docs/JOURNEY.md`, then `docs/ARCHITECTURE.md`, then the spec section for the package you want to touch.
- Run `npm test` and look at what is red.
- Pick an issue, or open one.
- If you are a researcher who wants to run or extend the benchmark, start at [docs/BENCHMARK.md](docs/BENCHMARK.md); the harness in `bench/` is designed to be run by people who are not us.
