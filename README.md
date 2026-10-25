# Averri

![status: pre-alpha, V0 in progress](https://img.shields.io/badge/status-pre--alpha%2C%20V0%20in%20progress-orange)
![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

**Averri is a contract and semantic-graph layer for agent-written TypeScript backends.** You declare, in ordinary TypeScript, what each action requires, what it ensures, and who may call it. A compiler turns those declarations into a verified graph of your backend (entities, actions, policies, events, workflows, routes, effects), checks them against the handler code that actually runs, generates tests from them (auth matrices, precondition boundaries, postcondition properties, known third-party pitfalls), and exposes the whole thing to coding agents through six small MCP tools and a `--json` CLI. It attaches to an existing Prisma + Hono/Express + Zod repo without a rewrite, a new file format, a hosted runtime, or generated application code.

The problem it targets is specific: coding agents now write a large share of the code in many backends, and the code they write compiles, passes the tests they wrote in the same session, and is still subtly wrong in the same places over and over (a route with no authorization, a webhook whose body was parsed before the signature was verified, a payment handler with no idempotency guard, a Zod schema that drifted from the Prisma field it validates). Averri's bet is that a human-approved contract, declared once, checked by a compiler, and flagged when weakened, catches that class in a way a same-session agent test cannot. Whether the bet holds is an open question, and this repo ships the benchmark meant to answer it (see [docs/BENCHMARK.md](docs/BENCHMARK.md)).

## Who it is for

- **Developers running coding agents** (Claude Code, Cursor, Codex, Copilot, Amp) on TypeScript backends who want the agent to stop guessing their invariants and want to see, on every PR, what semantically changed and whether a contract got weaker.
- **Coding-agent enthusiasts and tool builders** who want a concrete, measurable test of the claim that structured semantic context beats a well-documented repo plus LSP.
- **Researchers** interested in agent task cost, contract-derived test generation, or the no-training-data problem for library-shaped DSLs. The design rationale, the full research round, and the pre-registered benchmark are all in this repo.

## Twenty lines

```ts
// src/members/inviteMember.ts  (existing Hono + Prisma app; no schema changes)
import { entity, policy, action, event, e, db } from "@averri/core";
import { z } from "zod";

export const Invitation = entity("Invitation", { owner: "team-platform" });   // name = Prisma model name

export const OwnerOrAdmin = policy("Team.OwnerOrAdmin", {
  intent: "Owners and admins manage membership; members cannot.",
  allow: db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }),
});

export const MemberInvited = event("MemberInvited", { payload: { invitationId: "string", teamId: "string", email: "string" } });

export const InviteMember = action("Team.inviteMember", {
  intent: "An owner or admin invites a person by email. Re-inviting a pending email resends; inviting an existing member is an error.",
  route: { method: "POST", path: "/teams/:teamId/invitations" },      // must match an existing route
  input: z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) }),
  output: "Invitation",
  policy: OwnerOrAdmin,
  requires: { notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),
              emailDomainAllowed: async ({ input, actor }) => allowlist.check(actor.orgId, input.email) },   // tier 3: opaque guard
  ensures:  { pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
              eventEmitted: e.emitted(MemberInvited, 1) },
  effects: ["db:write", "event:emit"],
  // no `run`: observe mode. Contracts are checked around your existing route under Vitest; nothing is in the request path.
});
```

From this, with no application code generated, Averri derives: Policy, Contract, Event, and Action nodes with a verified `writes -> Invitation` edge and declared `reads -> Membership` edges from the policy and the predicate; a diagnostic if the route has no matching registration or no policy; a generated Vitest suite (auth matrix for anonymous / member / other-team admin / admin, a `notAlreadyMember` violation rejected (412 with the contract id once the action runs in declared mode), a fast-check property for `pendingForEmail`, exactly one `MemberInvited` emitted); an OpenAPI entry; and a Markdown spec card a non-engineer can review. The bare async function (tier 3, an opaque guard) is listed as opaque and gets no generated test; the compiler reports how many of your contracts are opaque.

Contracts come in three tiers, and the tier is visible in the type system: `e.*` expressions (serializable AST, fully derivable), `db.*` predicates (a closed set over Prisma models), and bare `async (ctx) => boolean` functions (tier 3 "guards": arbitrary logic, traced and enforced but excluded from generation). See the design document for why this split exists and what each tier buys.

## The six agent tools

Transport is MCP over stdio (and HTTP), plus `averri <tool> --json` with identical output for agents composing in Bash. Every response carries `commit` and `stale: false`; the server rebuilds by content hash on demand and never silently returns a stale answer.

| Tool | Question it answers | Input | Output (bounded) |
|---|---|---|---|
| `overview` | Where am I? | `{}` | stack, entry points, test/build commands, 5-line conventions, counts by node kind, health (uncovered routes, opaque-guard ratio, stale tests). Under 1.2k tokens. |
| `find` | Where is X? | `{query, kind?, limit=20}` | one line per hit: `id \| kind \| path:line \| origin \| summary`. Under 800 tokens. |
| `inspect` | What is true about this node? | `{id, include?: ["source","history","tests"]}` | spec-card fields, verified effects, callers and dependents as ids, tests; source inline when under 400 tokens. Under 2k tokens. |
| `impact` | What breaks if this changes? | `{id}` or `{diff}` | affected nodes with the edge path that makes them affected, tests to run, migration needed y/n, API-breaking y/n, contracts weakened y/n. Under 1.5k tokens. |
| `check` | Is my change correct? | `{scope: "affected" \| "all", diffBase?}` | structured diagnostics with deterministic fixes where the repair is deterministic, test results keyed by contract id, "N generated + M hand-written tests cover your change". Under 2k tokens. |
| `explain` | Why did this fail? | `{testId \| diagId \| traceId, detail?}` | failing assertion with actual vs expected, pasteable triggering input, causal chain (route, policy, contract, handler line), diff since last green, contract declaration site. Under 1.5k tokens. |

Two passthroughs complete the set: `read_source {file, range?}` so the agent is never blocked by the graph, and `suggest {id?}`, which drafts `intent` and contracts for undeclared handlers from existing Zod schemas, guards, and tests, returned as a proposed diff for a human to approve.

Deliberately absent: an IR patch language (agents edit text), session-aware deltas (wrong after context compaction and in subagents), and a token-spend dashboard (an MCP server cannot see token counts).

## Install and use

Nothing is published yet. The commands below are the intended surface once the packages are on npm; until then, [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) has the exact commands to run everything from a checkout, including the MCP configuration for Claude Code and Cursor.

```sh
npm install --save-dev @averri/cli @averri/core
npx averri init      # detects Prisma + Hono/Express + Zod, writes averri.config.ts,
                     # and adds a 40-line block to CLAUDE.md / AGENTS.md / .cursor/rules
npx averri check     # typecheck + lint + affected generated and hand-written tests, structured output
npx averri docs      # Markdown spec card per action (SPEC.md per module)
```

MCP configuration for Claude Code:

```sh
claude mcp add averri -- npx -y @averri/cli mcp
```

MCP configuration for Cursor (`.cursor/mcp.json`):

```json
{ "mcpServers": { "averri": { "command": "npx", "args": ["-y", "@averri/cli", "mcp"] } } }
```

Requirements for V0: Node 20+, TypeScript 5.x, Prisma, Hono or Express, Zod. One ORM, two routers, one validator. Nothing else in V0.

## What Averri is not

Not a new file format or language. Not a runtime you host. Not a replacement for Prisma, Hono, Express, Zod, Temporal, Inngest, or your auth library; it compiles to them and binds to them. Not a code-search tool. Not a token-spend dashboard. In V0 there is nothing to eject: remove the `@averri/*` imports and the generated test directory and your app is what it was.

## Status

Pre-alpha. V0 runs end to end from a checkout; nothing is published to npm yet. To try it, follow [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md). The roadmap, with explicit non-goals, is in [docs/ROADMAP.md](docs/ROADMAP.md).

What works today (verified on 2026-10-25 against `examples/seed-app`, a 38-route Hono + Prisma + Zod backend):

- **Compiler and graph.** Entities and fields from `schema.prisma`, Hono and Express routes, Zod schemas, hand-written Vitest tests, and the seven declaration constructs, lowered statically (declarations are never imported). Route binding, policy coverage, field references, effect verification against the handler (including events published through your own bus in observe mode), weakening detection, a content-hash cache. On the seed app it found a GET handler that wrote to the database and a postcondition naming a field the response does not have.
- **Generated tests.** Auth matrix, precondition violations, postcondition properties, event counts, entity invariants, workflow consumers, and webhook pitfalls (signature, raw body, idempotency) for a real app in observe mode. On the seed app: 264 generated tests pass alongside 116 hand-written ones; 17 are `it.todo` with the reason (row-count fixtures, clauses mixing predicates with other conditions).
- **Runtime.** Declared mode (`handle`, `toHono`, `toExpress`) and the observe-mode Vitest wrapper, with JSONL traces.
- **Agent surface.** All eight MCP tools over stdio and HTTP, and the same results from `averri <tool> --json`; `init`, `build`, `check`, `docs`, `report`, `fmt`, `testgen`, `suggest`.
- **Tests.** `npm run typecheck` is clean and `npm test` passes: 94 files, 1033 tests, 17 marked todo. The full suite takes about six minutes, mostly because many compiler tests build a whole project.

What does not work yet:

- No npm release. Using the generated tests in a repo outside this monorepo means linking `@averri/core`, `@averri/contracts` and `@averri/ir` from a checkout (they ship TypeScript sources), and the snippet `init` prints (`npx averri mcp`) needs the CLI installed.
- No incremental build: a cold build of the seed app takes about 8 to 18 seconds (the spec targets under 3 seconds incremental); cached queries are instant. `check --scope all` on the seed app takes 1 to 3 minutes.
- Fixture synthesis cannot produce row counts (`db.countWhere`), compound primary keys, or violations of clauses that mix `db.*` predicates with other conditions; those tests are emitted as `it.todo`.
- Express support is covered by the extractor and runtime tests, not by an example app. Only Prisma, Hono/Express and Zod are supported.
- The benchmark harness in `bench/` is not built; no benchmark result exists.
- Git-dependent paths (`check --base`, `impact --base`, `inspect` history) have unit coverage only through `report`.

This project started as an attempt to design a new, agent-native programming language and ended up here after a research round and a build-or-pass review in which three independent reviewers said pass. The founder built it anyway, as a community project. That story, including what was dropped and why, is in [docs/JOURNEY.md](docs/JOURNEY.md). Read it before assuming the design is more certain than it is.

## Documents

- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md): run the seed app, the CLI and the MCP server from a checkout, and point Averri at your own repo.
- [docs/JOURNEY.md](docs/JOURNEY.md): from AgentLang to Averri; what was kept, what was dropped, and why.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the IR, the three-tier contract language, the compiler and runtime stack.
- [docs/BENCHMARK.md](docs/BENCHMARK.md): AgentCodeBench v0 pre-registration draft, with kill criteria and an invitation to reproduce.
- [docs/ROADMAP.md](docs/ROADMAP.md): V0 milestones and non-goals.
- [docs/research/](docs/research/): the full research round that produced the design. Figures in those documents were gathered by AI research agents and have not been independently verified.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache-2.0. See [LICENSE](LICENSE). Contributions are accepted under the Developer Certificate of Origin; there is no CLA. Generated output (tests, spec cards, OpenAPI) belongs to you and is unencumbered. This project will not be relicensed.
