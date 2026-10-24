# Final Strategy & Design: An Agent-Native Backend Representation, Built in the Order That Survives

## 1. Verdict in one paragraph

Yes, this is worth doing, but not as a language first and not as the concept document sequences it. The durable idea in the concept is the compiler-maintained Semantic IR with contracts, policies, effects, intent, and impact as verified facts; the fragile idea is new syntax. The research is unambiguous: custom DSLs lose to TypeScript tooling even with funding (Wasp), proprietary runtimes die (Darklang), code-graph retrieval is already free and being absorbed by Claude Code's LSP and persistent agent memory, and frontier models halve their navigation waste roughly yearly. What does not erode is "compiles but subtly wrong" (missing auth, webhook raw body, idempotency, layer mismatches) and the governance of what agents changed. So: build the IR as the product, expose it through a small TypeScript-embedded typed declaration layer that attaches to existing Prisma + Hono/Express repos in an afternoon, derive tests and impact from it (no application codegen in V0), sell a PR-level contract/impact bot to teams and governance to enterprises, and publish a benchmark credible enough that a skeptic cannot dismiss it. The thing that must be proven first, by month 4 with one model and N=10, is that contracts plus impact plus structured diagnostics raise hidden-test pass rate and cut iterations beyond what a well-documented repo with LSP already gets. If they do, Stage 2 (declarations that derive routes, schema, migrations) is earned; a bespoke `.al` syntax is a 2028 question that only a corpus and a Stage 2 number can answer. If they do not, the company is a contracts-and-impact layer for TypeScript backends, which is still a business, and you will have found out for under $200K.

## 2. What the concept document got right and what it got wrong

**Right:**
- The optimization target. "Agent Task Cost" (tokens + iterations + tool calls + failed attempts) rather than token count is correct; input tokens are ~75% of spend and agentic tasks cost ~1000x chat (arXiv 2604.22750, Vaughan 2026). Syntax compression research tops out at 10-35% (SimPy, Token Sugar); the lever is fewer reads and fewer failed iterations.
- Semantic IR as the asset. Code graphs are commoditized (CodexGraph, Aider repo map, CodeGraph MCP, Augment, Greptile), but none carries contracts, effects, ownership, or impact as compiler-verified facts. That gap is real and is the whole moat.
- "Don't make AI generate what deterministic software can generate." Derived layers remove the schema/validator/DTO/route mismatch class, which the agent-cost analysis puts at 15-30% of cost.
- Structured diagnostics with suggested patches. RustAssistant-class evidence (74-93% fix rate on structured compiler errors) supports it; mapping error signatures to repair strategies deterministically is what beats the feedback plateau.
- Staged plan, benchmark-gated. "Don't bet the company on syntax" is the correct instinct and the rest of this document takes it literally.
- No proprietary runtime lock-in; compile to Postgres/TypeScript. Darklang, Parse, and Meteor are the graveyard for the alternative.

**Wrong:**
- "Build a language" as the first product. Wasp abandoned its DSL in 2026 for a TS spec with YC money and eight people; Keel pivoted to vertical services; Encore, the closest analogue, has ~200 production teams after five years. The no-training-data penalty is paid in every context window forever (NeurIPS 2025 esolang study: docs-in-context gets you "some" correct code and a large gap). A TS-embedded form inherits the prior; a `.al` grammar does not.
- "Agents are bad at navigating codebases." Largely eroded for frontier models (1-2 turns to first-correct, 40-140 wasted post-success tokens per the Tokenmaxxing study). Claude Code dropped embeddings for grep+LSP because it worked better. You cannot sell navigation; by the time you ship, Codex memory, Antigravity Knowledge Items, and Cursor team indexes will have given it away.
- "60% fewer tokens" as the headline. A token win at equal pass rate is reproducible by writing less code and convinces nobody. The claim that matters is pass-rate and iteration reduction on hard, policy-sensitive tasks, measured against a documented repo.
- Stage 1 as "graph over existing TS projects." As written it is a free category. The architecture brief's own extraction numbers (contracts/policies/events "essentially unrecoverable", Express routes 50-80%) mean an un-annotated graph is Prisma entities the agent already reads in 2k tokens. Stage 1 only has value if it ships the contract layer on day one.
- Semantic primitives as language keywords (`cache`, `retry`, `queue`, `workflow`). Temporal ($12.55B), Restate, Inngest own durable execution; Supabase/Neon own agent-provisioned Postgres; Better Auth/Clerk own authn. Compile to them, never reimplement them.
- Mining agent logs to promote primitives. Correct eventually, but requires usage you will not have for a year; it is an M12+ feature, not a design input.
- General-purpose expressivity in contracts. The concept implies arbitrary logic; the agent-cost brief and three critics converge on the same point: contracts must be a decidable, serializable subset or every downstream promise (test generation, auth matrices, impact, actual-vs-expected) is vapor.

## 3. The product: name options, positioning, what it is / is not

**Name.** "Lattice" and "AgentLang" are both unusable (Lattice is a $3B HR company and a semiconductor firm; "Lang" pre-commits to the DSL). Candidates, trademark check required before any public artifact: **Warrant** (a warrant is a verified guarantee; "warranted facts about your code"), **Intentio**, **Graphwright**, **Keystone**. This document uses Warrant as the working name: `@warrant/core`, `@warrant/mcp`, `warrant` CLI, Warrant PR Bot, Warrant Enterprise.

**Positioning, one sentence:** *Warrant is the contract layer for agent-written backends: declare what each action requires, ensures, and who may call it; the compiler turns that into verified graph facts, generated tests, and impact reports that every coding agent can query and every reviewer can trust.*

Messaging pillars, in order: agents stop guessing your invariants (correctness); reviewers see what semantically changed and whether a contract got weaker (governance); agents stop re-reading your repo (cost, third because it erodes).

**What it is:**
- An Apache-2.0 indexer + typed declaration library + MCP/CLI for existing TypeScript backends on Prisma with Hono or Express and Zod. One ORM, two routers, one validator in V0. Nothing else.
- A Semantic IR (typed property graph, SQLite-cached, rebuilt on demand) with three provenance levels on every node: `extracted` (heuristic, with evidence), `declared` (a human or agent wrote it), `verified` (a static scan confirmed the declaration against handler code).
- A contract library with two adoption modes: `observe` (asserts at the HTTP boundary, zero handler changes, test-time only) and `defineAction` (refactored handler, runtime pipeline, owns the transaction). Teams start with observe.
- Generated tests (auth matrix, precondition boundaries, postcondition properties, pitfall tests), OpenAPI, and Markdown spec cards. No generated application code in V0.
- A PR bot that posts semantic impact, contract and policy coverage, and contract-weakening flags on every PR regardless of author.
- A public, pre-registered benchmark, AgentCodeBench.

**What it is not:** a new file format; a runtime you must host; a replacement for Prisma, Hono, Temporal, Inngest, or Better Auth; a code-search tool; a token-spend dashboard (the MCP server cannot see token counts; see section 8 for the honest version); a general-purpose language.

## 4. Representation & language design

**Decision.** The IR is the product. The primary projection is a TypeScript-embedded typed declaration layer. The human projection is a deterministic Markdown spec card per action. A bespoke `.al` grammar is a possible third projection, deferred until (a) Stage 2 codegen exists and (b) a public corpus of at least a few hundred repos exists to teach it from.

**Rationale.** The model's TypeScript prior transfers to syntax; tsc and the LSP catch key-name mistakes for free; no formatter, highlighter, or editor plugin to build; Zod/Drizzle/Convex are existence proofs that agents handle library-shaped DSLs. The architecture brief's objection (tsc diagnostics are unstructured) is handled by not using tsc as the semantic analyzer: the compiler loads declaration modules with ts-morph, lowers object literals into IR with source ranges, runs its own domain checks, and emits its own diagnostics; tsc runs afterward as a backstop.

**The contract contradiction, resolved.** All six critiques found the same flaw: every proposal wrote contracts as opaque lambdas while promising fast-check generation, auth matrices, impact, and actual-vs-expected. The fix is a three-tier contract language with the tier visible in the type system:

1. **Expressions** (`e.*`): typed combinators over `input`, `self`, `result`, `actor`, `old(self)` that build a serializable AST at runtime. No parsing of lambda bodies; tsc checks field names against generated types; the IR stores `{op, lhs, rhs}`. Supports comparisons, boolean ops, `in`, `len`, `sum/count/exists` over owned lists (depth ≤ 3). Test generation derives a violating arbitrary per clause; `explain_failure` reports evaluated LHS/RHS.
2. **Predicates** (`db.*`): a closed set of declarative DB predicates (`exists`, `none`, `unique`, `countWhere`) over Prisma models with literal where-clauses. Compile to Prisma queries at runtime, to SQL for Stage 2, and to fixture generators for tests. This covers "not already a member", "invoice is open", "team exists", which is where the expressiveness cliff would otherwise be hit in week one.
3. **Guards** (`guard(fn)`): arbitrary async lambdas with access to the project's own Prisma client. Traced, enforced at test time, listed in the spec card as "opaque guard", excluded from test generation and static impact. The compiler counts them; the handler-line and opaque-guard ratios are reported in `overview`.

tsc cannot tell an agent it has left tier 1 for tier 3, but it does not need to: tiers are different functions with different return types, and the Markdown spec card shows "verified" versus "opaque" per clause. An ESLint rule warns when a `guard` could be expressed as an expression.

**Human-readability guarantee.** One construct per concept, one spelling, no sugar, fixed key order enforced by `warrant fmt`. `intent` is recommended everywhere, surfaced in `inspect`, required only on exposed actions in `defineAction` mode, never on extracted nodes. `warrant docs` renders every action to a spec card (intent / who may / preconditions / postconditions / effects / tests / owner / last change) in under 15 lines; a non-engineer must be able to review the example app from spec-card diffs alone, and that is a release gate on the reference app. `warrant suggest` drafts intent and contracts from existing Zod schemas, guards, and tests so the graph is not empty in week one and humans approve spec cards in a PR.

**Worked example: "Team.inviteMember" in an existing Hono + Prisma repo.**

```ts
// src/members/inviteMember.ts
import { entity, policy, action, event, workflow, guard, e, db } from "@warrant/core";
import { prisma } from "../db";
import { inngest } from "../inngest";
import { sendInviteEmail } from "../email";

// Entity facts attached to the existing Prisma model (no schema changes).
export const Invitation = entity("Invitation", {
  model: "invitation",                                   // prisma model name, checked
  owner: "team-platform",
  invariant: { pendingHasNoAcceptedAt: e.or(e.ne("status", "pending"), e.isNull("acceptedAt")) },
});

export const OwnerOrAdmin = policy("Team.OwnerOrAdmin", {
  intent: "Owners and admins manage membership; members cannot.",
  allow: db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"),
                                   role: { in: ["owner", "admin"] } }),
});

export const MemberInvited = event("MemberInvited", {
  payload: { invitationId: "string", teamId: "string", email: "string" },
});

export const InviteMember = action("Team.inviteMember", {
  intent: "An owner or admin invites a person by email. Re-inviting a pending email resends; inviting an existing member is an error.",
  route: { method: "POST", path: "/teams/:teamId/invitations" },   // must match an existing Hono route
  input: z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) }),
  output: "Invitation",
  policy: OwnerOrAdmin,
  requires: {
    notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),
    emailDomainAllowed: guard(async ({ input, actor }) =>            // opaque: external allowlist service
      allowlist.check(actor.orgId, input.email)),
  },
  ensures: {
    pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
    eventEmitted: e.emitted(MemberInvited, 1),
  },
  effects: ["db:write", "event:emit"],
  transaction: true,
  run: async ({ input, actor, tx, emit }) => {                      // tx is the project's Prisma tx client
    const inv = await tx.invitation.upsert({
      where: { teamId_email: { teamId: input.teamId, email: input.email } },
      create: { teamId: input.teamId, email: input.email, role: input.role, invitedBy: actor.id, status: "pending" },
      update: { role: input.role, resentAt: new Date() },
    });
    emit(MemberInvited, { invitationId: inv.id, teamId: inv.teamId, email: inv.email });
    return inv;
  },
});

export const InviteFlow = workflow("InviteFlow", {
  on: MemberInvited,
  runner: inngest.createFunction({ id: "invite-flow" }, { event: "warrant/MemberInvited" }, async ({ event, step }) => {
    await step.run("email", () => sendInviteEmail(event.data.email, event.data.invitationId));
    await step.waitForEvent("accepted", { event: "warrant/InvitationAccepted", timeout: "7d" });
  }),
  retry: { attempts: 3 },
});
```

The same action in **observe mode** (week-one adoption, handler untouched): replace `run` with `handler: listRoutes.inviteMember` (a reference to the existing `(c) => ...` Hono handler) and `transaction` is omitted; `requires`/`ensures` are evaluated at test time from request/response bodies and DB before/after snapshots. The declared form is a strict superset: an agent that learned observe mode relearns nothing.

From this declaration the compiler derives, with no application code generated: Policy, Contract, Event, Workflow, and Action nodes with `writes -> invitation` and `reads -> membership` edges (verified by scanning `run` for `tx.<model>` calls); a diagnostic if `/teams/:teamId/invitations` has no matching route or the route has no policy; a generated Vitest suite (auth matrix: anonymous / member / other-team admin / admin; `notAlreadyMember` violation returns 412 with contract id; a fast-check property for `pendingForEmail`; exactly one `MemberInvited` emitted; `InviteFlow` consumer exists for the event); OpenAPI entry; spec card. The `guard` is listed as opaque and gets no generated test.

**IR sketch (abridged):**

```json
{
  "id": "Action:Team.inviteMember", "kind": "Action", "origin": "declared",
  "src": {"file": "src/members/inviteMember.ts", "range": [[22,0],[48,3]]},
  "intent": "An owner or admin invites a person by email...",
  "route": {"method": "POST", "path": "/teams/:teamId/invitations", "exposure": "Exposure:hono:src/routes/teams.ts:41", "verified": true},
  "input": {"zod": "src/members/inviteMember.ts#InviteMember.input", "fields": ["teamId","email","role"]},
  "output": "Entity:Invitation",
  "policy": "Policy:Team.OwnerOrAdmin",
  "contracts": [
    {"id": "C:Team.inviteMember.requires.notAlreadyMember", "phase": "requires", "tier": "predicate",
     "expr": {"op": "none", "model": "membership", "where": {"teamId": {"ref": "input.teamId"}, "user.email": {"ref": "input.email"}}}},
    {"id": "C:Team.inviteMember.requires.emailDomainAllowed", "phase": "requires", "tier": "guard", "opaque": true},
    {"id": "C:Team.inviteMember.ensures.pendingForEmail", "phase": "ensures", "tier": "expr",
     "expr": {"op": "and", "args": [{"op": "eq", "lhs": {"ref": "result.email"}, "rhs": {"ref": "input.email"}},
                                     {"op": "eq", "lhs": {"ref": "result.status"}, "rhs": {"lit": "pending"}}]}}
  ],
  "effects": {"declared": ["db:write","event:emit"], "verified": {"writes": ["Entity:Invitation"], "reads": ["Entity:Membership"], "emits": ["Event:MemberInvited"]}},
  "edges": {"authorizes": ["Policy:Team.OwnerOrAdmin"], "emits": ["Event:MemberInvited"], "consumedBy": ["Workflow:InviteFlow"],
            "verifiedBy": ["Test:gen/Team.inviteMember.auth-matrix", "Test:gen/Team.inviteMember.requires.notAlreadyMember"]},
  "ratios": {"opaqueGuards": 1, "totalContracts": 4},
  "history": [{"commit": "a1f3c9", "op": "add-contract", "target": "requires.emailDomainAllowed", "at": "2026-10-09T14:02:11Z"}]
}
```

Identity: the string id in the call (`"Team.inviteMember"`) is the durable id; the compiler errors on duplicates and warns when an id disappears and a new one appears with the same `run` reference (rename detection). No ULIDs, no committed `ir.json`: the graph lives in a gitignored `.warrant/` cache rebuilt on demand, and history is computed by building at two commits. This removes the merge-conflict generator the critics flagged.

## 5. Agent interface

Transport: MCP over stdio for Claude Code, Cursor, Codex, Copilot, Amp; `warrant <tool> --json` CLI with identical output for agents composing in Bash. `warrant init` writes a 40-line block into `CLAUDE.md` / `AGENTS.md` / `.cursor/rules`: call `overview` once, use `find`/`impact` before editing entities or routes, run `check` instead of raw tsc+vitest, trust generated contract tests, never weaken a contract to get green without saying so in the PR. Docs for each construct are an MCP resource, not a tool, so they cost nothing until fetched. Six tools, budgets set by relevance rather than a flat cap; every response carries `commit` and `stale: false` (the server rebuilds on demand by content hash and never returns a stale answer silently):

| Tool | Purpose | Input | Output (bounded) |
|---|---|---|---|
| `overview` | Session orientation | `{}` | stack, entry points, test/build commands, 5-line conventions, counts by node kind, health (uncovered routes, opaque-guard ratio, stale tests). ≤1.2k tokens |
| `find` | Locate by meaning or name | `{query, kind?, limit=20}` | one line per hit: `id | kind | path:line | origin | summary`. ≤800 tokens |
| `inspect` | Everything about one node | `{id, include?: ["source","history","tests"]}` | spec card fields, verified effects, callers/dependents as ids, tests; source span inline when under 400 tokens. ≤2k tokens |
| `impact` | What breaks if this changes | `{id}` or `{diff: unified}` | affected nodes with *why* (edge path), tests to run, migration needed y/n, API-breaking y/n, contracts weakened y/n. ≤1.5k tokens |
| `check` | Typecheck + lint + affected tests, structured | `{scope: "affected" \| "all", diffBase?}` | diagnostics[] (format below), test results with contract ids, "N generated + M hand-written tests cover your change". ≤2k tokens; target <10 s on 20k LOC |
| `explain` | Why a test, diagnostic, or trace failed | `{testId \| diagId \| traceId, detail?}` | failing assertion with actual vs expected, triggering input (pasteable), causal chain (route → policy → contract → handler line), diff since last green, contract declaration site + author. Stack trace retrievable at `detail: "full"`. ≤1.5k tokens |

Plus `read_source {file, range?}` as a passthrough so the agent is never blocked, and `suggest {id?}` (drafts intent/contracts for undeclared handlers, returns a proposed diff). Dropped from V0 on the agents' own testimony: `apply_patch` with IR op vocabulary (agents edit text and route around a foreign patch language), session-aware deltas (wrong after compaction or in subagents; opt-in via `seen=[ids]` only), and `conventions` (folded into `overview` and `inspect`).

**Diagnostic format** (≤300 tokens, one root cause per cascade where the heuristic can attribute it):

```json
{"id": "D-0042", "code": "W2103", "severity": "error",
 "title": "Exposed route has no policy",
 "node": "Exposure:hono:src/routes/teams.ts:41", "path": "src/routes/teams.ts:41",
 "cause": [{"node": "Action:Team.inviteMember", "why": "declared route POST /teams/:teamId/invitations"},
           {"node": "Exposure:hono:src/routes/teams.ts:41", "why": "no `policy` and not marked public"}],
 "related": ["Policy:Team.OwnerOrAdmin"],
 "fixes": [{"label": "Reuse Team.OwnerOrAdmin", "evidence": "used by 3 sibling Team.* actions", "patch": "--- a/src/members/inviteMember.ts ..."}],
 "since_last_green": "+1 action, +1 route", "docs": "warrant://docs/policy"}
```

Rules: fixes only on codes whose repair is deterministic (missing policy, undeclared event, dropped field, route mismatch, raw-body on webhook); no fabricated confidence floats, an `evidence` string instead; for logic and test failures return actual-vs-expected and the diff since green with no hypothesis. Cascade collapse is a diff-scoped heuristic (group tsc errors by the first symbol introduced or renamed in the diff) and is described as such, not sold as root-cause analysis.

**Edit protocol.** Agents edit TypeScript with their native tools. `check` is the validation step; `impact {diff}` is the pre-edit question. In Stage 2, a pre-commit hook and the PR bot refuse edits to `@generated` files. There is no IR patch language in V0.

**Debugger scope for V0.** The contracts runtime records one trace per action invocation in test and dev (phases: validate, authorize with decision and actor summary, each requires with evaluated values, handler duration and model calls, each ensures, emits). Storage: a local SQLite trace store in `.warrant/`, never the customer's application database. `explain` walks trace plus graph. Production traces are an opt-in OTel exporter. Counterfactual replay, failing-sequence minimization, and learned fix ranking are post-V1 research.

## 6. Compiler & runtime target stack and how escape hatches/ejection work

**V0 (attach mode, no app codegen):**
- Extractor: ts-morph over the project; `@prisma/internals` `getDMMF` for the Prisma schema (~95% accurate); Hono and Express route extraction for static registrations (dynamic mounts become `Exposure` nodes with `origin: extracted`, `evidence`, and a "verify by reading" note; below ~90% confidence the tool refuses to answer rather than guess); Zod schemas by reference.
- Declaration layer: `@warrant/core` (`entity`, `policy`, `action`, `event`, `workflow`, `integration`, `e`, `db`, `guard`), branded literal-union option types so tsc catches hallucinated option values; no string mini-DSLs anywhere.
- Runtime: `@warrant/contracts` with two modes. `observe` runs only under Vitest via an adapter that wraps the Hono app or Express router (zero changes to handlers, no transaction ownership, no idempotency table, no event bus; emitted events are detected by a test-time spy on the project's own emitter/queue client). `defineAction` is the opt-in refactored mode: it owns the pipeline (validate → authorize → requires → tx → run → ensures → emit) using the project's Prisma `$transaction`, with `requires` always on in prod and `ensures` sampled. A paid external security review of `defineAction` and the policy evaluator precedes the public release.
- Integrations with encoded pitfalls: `integration("Stripe", { webhook: { verify: "stripe-signature", rawBody: true } })` generates a runtime test that posts a signed raw body and asserts verification, rather than a static middleware-order check (Express middleware ordering is too dynamic to trust statically). Idempotency in observe mode is a generated duplicate-delivery test plus a lint; in `defineAction` mode it is a primitive with a dedupe table migration.
- Tests: Vitest, fast-check, pglite in-process by default, testcontainers Postgres opt-in. Generated tests live in `tests/warrant/*.gen.test.ts` with `@generated` headers.
- Graph: SQLite via better-sqlite3 with FTS5, gitignored, rebuilt on demand (target <3 s incremental on 60k LOC; `<500 ms` is not promised).
- MCP: `@modelcontextprotocol/sdk`, stdio and HTTP.
- PR bot: Probot GitHub App; the graph is computed inside the customer's CI runner (`warrant report --base main`), and only the report JSON leaves the VPC. This is what makes a Team tier sellable to a security team.
- Docs: `warrant docs` writes `SPEC.md` per module.

**Stage 2 (declared mode with derivation, gated on the benchmark):** declarations gain `fields`, `paginate`, `filter`, `sort`, `tenant`; the compiler emits what the customer already uses, not a second stack: Prisma schema fragments and migrations, Hono/Express routes, Zod schemas, OpenAPI, Inngest or pg-boss consumers for workflows. No Drizzle, no bespoke data-access facade; handlers use the project's own Prisma client and effects are inferred from `tx.<model>` calls, which is the one place static inference is reliable. Generated files carry `// @generated by warrant <version> from <id> — do not edit`, are written only on content-hash change, deleted when their node disappears, and `warrant check --clean` fails CI on drift.

**Escape hatches (exactly three, all typed, all scanned):** `run`/`handler` (TS function receiving typed ctx), `guard` (opaque contract), `integration` (foreign API client). Each contributes edges via import and call scanning; the handler-line ratio and opaque-guard ratio are reported in `overview`, and if handler TS exceeds ~40% of lines on the reference app the primitive set is too thin.

**Ejection.** In V0 there is nothing to eject: remove `@warrant/*` imports and the generated test directory, and the app is what it was. In Stage 2, `warrant eject` strips `@generated` headers, deletes `.warrant/`, and leaves a plain Prisma + Hono project; this is demoed before Stage 2 ships and is the no-lock-in proof.

## 7. The benchmark that must be believed

**Design.** AgentCodeBench v0: 20 tasks on one seed SaaS app (orgs, members, invites, RBAC, Stripe billing webhook) at ~20k LOC in Hono + Prisma, authored by a contractor outside the team. Four categories × 5: feature (cursor pagination, RBAC change, soft delete, audit log, rate limit), bug fix (validation layer mismatch, race on invite upsert, N+1, timezone, off-by-one cursor), third-party (Stripe webhook idempotency, S3 upload, OAuth callback, email bounce), ops (idempotency keys, retries, metrics). Tasks are PM-style tickets with hidden HTTP-level acceptance tests and a hidden regression suite; task selection targets a 40-70% baseline pass rate to avoid ceiling effects. A 10-task held-out set is written after the primitive set is frozen.

**Arms.**
- A: plain repo + maintained CLAUDE.md + ARCHITECTURE.md + Claude Code LSP on. This is the honest control; a bare repo would measure "we wrote the docs."
- A+lib: A plus the pitfall primitives (webhook verify, idempotency, cursor pagination) shipped as an ordinary library with no compiler. Separates "good library" from "representation."
- A+graph: A plus a free generic code-graph MCP (e.g. CodeGraph). Separates retrieval from semantics.
- B: A plus Warrant in observe mode with contracts declared on the 30 existing actions, MCP enabled, the CLAUDE.md block and tool schemas charged to this arm.
- B+: B with the declared `defineAction` mode on the same actions.
- C/D (Stage 2 arms) only when Stage 2 exists.

**Controls.** One model first (Claude Sonnet-class, pinned), Claude Code pinned, same system prompt, same tool-call and wall-clock budget, fixed temperature, N=10 per cell. 20 × 5 arms × 10 = 1,000 sessions at $5-15 = $5-15K per full run; second model added only after the first run is published. Pre-registration posted publicly (OSF or the repo) before any run. Tool-usage rate (fraction of sessions that actually called Warrant tools) is reported, because advisory CLAUDE.md instructions are ignored a meaningful fraction of the time.

**Metrics.** pass@1 on hidden tests (primary); hidden-regression breaks; tokens split input/cached/output on the jointly-solved subset; tool calls; build/test runs; iterations to green; stuck rate; diff size; contract-weakening events; blinded readability score on diffs; syntactic error rate on Warrant constructs reported separately.

**Headline claim it must support:** *On a documented 20k-LOC repo, Arm B+ raises hidden-test pass@1 by at least 10 absolute points over Arm A (non-overlapping 95% CIs at N=10) or cuts iterations-to-green by at least 30% at equal or better pass rate, and the gain is not captured by A+lib or A+graph.* Per-category results are published; the gain is expected to concentrate in auth, webhook, idempotency, and layer-mismatch tasks and to be near zero elsewhere, and the report says so.

**Credibility.** Tasks, harness, baseline app, and raw session logs public. Before any headline number is quoted in marketing, the harness is handed to a neutral third party (a university group or a benchmark organization; budget $10-20K) to reproduce. Encore's benchmark is vendor-run and the critics are right that ours would be dismissed on the same grounds without this. Quarterly re-run against the newest frontier model; the delta must not shrink faster than the team ships.

**Kill criteria.** If B+ beats A by under 5 points pass@1 and under 15% iterations, with A+lib capturing most of whatever gain exists: stop building the representation, ship the primitives as a library and the PR bot as a lint product, and do not start Stage 2. If B captures most of B+'s gain: contracts are a governance feature, not a correctness one; Stage 2 codegen is not started. If B+ clears the bar: Stage 2 is funded, and C/D arms are added at M12. The `.al` syntax question is not on the table until C/D exist and a corpus exists.

## 8. Business model

**License.** Apache-2.0 for indexer, declaration library, contracts runtime, compiler, MCP server, CLI, docs generator, benchmark harness. DCO, no CLA. License FAQ states generated output is the user's, unencumbered. Never relicense; HashiCorp, Redis, and Elastic each produced a fork and a trust crater. The PR bot server, hosted registry, and governance control plane are closed.

**Free (unlimited users, local, single repo):** everything above, including generated tests, spec cards, `warrant report` output in CI as a local artifact.

**Team, $20/dev/month, self-serve, up to 100 seats:** Warrant PR Bot on GitHub (impact summary, contract and policy coverage delta, contract-weakening flags, generated-test status), computed in the customer's CI with only the report leaving; multi-repo report history; shared contract library across repos. This is the first paid feature: a VP Eng or tech lead sees it in their own PR within an hour of install, it is useless without the OSS core so it pulls adoption rather than taxing it, and it does not require uploading source. Comparables: Greptile $30/seat, CodeRabbit $15-24; the differentiator is contract-aware semantics, not a generic summary.

**Enterprise, from $50K/year (typical $50-150K):** SSO/SAML, RBAC; policy-as-code gates ("no PR may remove a policy or weaken a `requires` on entities tagged `payment`", "every exposed route must have a policy", enforced as required checks regardless of author, which sidesteps the unreliable agent-vs-human signal); on-prem report server (1.5x); Claude Code cost telemetry via its OTel export only, honestly labeled as Claude Code-only; cross-repo `impact`; private benchmark runs on the customer's own repos; audit export of contract changes; SLA. Compliance packs (SOC2/PCI evidence from contract coverage) in year two. SOC2 Type I via Vanta starts month 8 because enterprise procurement will not clear without it.

**Dropped, honestly:** the token-cost-per-task dashboard as a general feature. An MCP server never sees token counts; Cursor and Codex do not expose per-task spend to third parties; Claude Code Enterprise, Copilot metrics, and Cursor Business already show per-user spend inside procurement. The hosted graph as a product is also dropped: it is a cache rebuildable in seconds and nobody pays to avoid that burden.

**First 10 customers.** B2B multi-tenant SaaS, 30-300 engineers, TypeScript monorepo on Prisma with Hono or Express, Claude Code or Cursor on most seats, a named owner of AI-enablement or platform, and a recent incident caused by agent-written code (missing auth, double-charged webhook). Fintech-adjacent and healthtech preferred because the policy gate sells itself. Found through the benchmark write-up, the Prisma and Hono communities, and direct outreach to companies posting publicly about agent incidents. Offer: free Team for six months plus free Enterprise gates in exchange for benchmark data on their real tasks and a logo; conversion at months 10-12, not 9.

**Positioning versus model vendors and clouds.** Warrant is the neutral semantic and governance layer that works inside every agent; it never competes with Claude Code, Codex, or Cursor on navigation, and it compiles to Prisma, Postgres, Inngest, Temporal, Supabase, and Neon rather than replacing them. Model vendors will not build cross-vendor contract governance neutrally; clouds will not build it runtime-agnostically. If Anthropic or GitHub ship a native contract layer, the company's assets are the benchmark, the installed PR-bot base, and the enterprise gates; see risk 10.

## 9. Roadmap

**Months 0-3 (build, two people).** Extractor for Prisma + Hono/Express + Zod; `@warrant/core` with the three-tier contract language and observe mode; generated auth-matrix, precondition, and pitfall tests; MCP with `overview/find/inspect/impact/check/explain` and the CLI; structured diagnostics for 10 codes with deterministic fixes; `warrant docs`; the contractor's seed app and 20 tasks with hidden suites. Demo criterion at M3: a Claude Code session on a 20k-LOC repo adds a policy-protected endpoint using only Warrant tools, `check` reports which generated tests cover it, and `impact` names the dependents. Gate: internal benchmark run (A vs B vs A+lib) shows a directional gain; if B+ is not ahead of A+lib at all, stop and rethink before spending on the public run.

**Months 3-6 (prove).** `defineAction` mode with external security review; `suggest`; AgentCodeBench v0 public with pre-registration, N=10, one model; third-party reproduction commissioned; public repo, docs, launch post. Demo criterion at M6: a published number with CIs, raw logs, and losses. Targets: 800-1,000 stars, 100 weekly active repos, 3 design partners signed. Gate (go/no-go #1): the kill criteria in section 7. No-go means the company becomes "primitives library + PR lint bot" and Stage 2 is cancelled.

**Months 6-12 (monetize).** PR Bot GA on GitHub, Team tier billing, policy gates and SSO for Enterprise, SOC2 Type I started, Claude Code OTel add-on, NestJS extractor only if two design partners need it, benchmark at 40 tasks with a second model and the held-out set. Targets: 20 paying Team accounts, 2 Enterprise design partners converting at M10-12 ($80-150K combined), $150-250K ARR run-rate at M12. Gate (go/no-go #2, M12): Stage 2 codegen is started only if B+ cleared the bar at M6, the quarterly re-run against the newest model has not erased it, and at least two paying customers ask for "new service in declared mode."

**Months 12-18 (extend).** If go: Stage 2 emitters (Prisma schema fragments, routes, Zod, OpenAPI, Inngest/pg-boss consumers), `tenant` primitive, `eject` demo, C/D benchmark arms, Stage 2 go/no-go on the `.al` projection question deferred to 2028. If no-go: Python/FastAPI extractor, deeper governance, compliance packs. Targets either way: $400-700K ARR, 6-8 enterprise logos, benchmark at 100 tasks with third-party tasks accepted. Seed raise decision at M12-15 on the M6 number plus ARR.

## 10. Team, burn, funding path

- **Founder (CTO/CEO):** IR, declaration library, contract language, diagnostics, MCP, benchmark design, design-partner sales. Non-delegable.
- **Senior TypeScript engineer, hired month 1:** extractor (must have shipped a ts-morph or Babel tool), contracts runtime, test generation, PR bot, CI integration.
- **Contractor, months 1-5, ~0.4 FTE:** seed app, tasks, hidden suites; external by requirement for credibility. Later, the neutral benchmark reproduction is a separate $10-20K engagement.
- **No devrel hire:** the benchmark is the devrel. Docs are written by the founder; the monthly benchmark post is the marketing calendar.
- **Buy, don't build:** Vanta for SOC2 (month 8+), Clerk or Better Auth for the control plane, Stripe billing, Probot for the GitHub App.

Burn: two salaries at modest founder-adjacent rates ($10-14K/month each fully loaded), contractor $4-6K, infra and model spend $2-3K, benchmark runs $5-15K each at M3 and M6 then quarterly, legal and accounting $1-2K. **$28-38K/month, roughly $500-650K through month 18.** No services revenue is assumed; the earlier plans' "bootstrap on design-partner services while giving them the product free" was a contradiction. Funding: founder capital or a $300-500K pre-seed from angels in dev tools to reach the M6 number; a $1.5-2.5M seed at M12-15 only if go/no-go #1 passed and Team revenue exists. If the M6 number fails, the remaining runway is enough to ship the lint-bot pivot and reach ramen profitability at ~$15K MRR.

## 11. Top 10 risks with mitigations

1. **No-training-data tax relocates into the library surface.** A 0.x library has zero prior; agents will hallucinate option values and misremember semantics (when does `ensures` run, does `transaction` cover `guard`). Mitigation: ≤12 constructs, one spelling each, every option a literal union so tsc rejects hallucinations, Zod for inputs (known cold), no string DSLs, the project's own Prisma client in handlers, a 1.5k-token core card in CLAUDE.md, 300-token semantics cards as MCP resources that specify ordering and transaction boundaries precisely, and syntactic-error rate reported in the benchmark. Residual risk: real until a public corpus exists; the benchmark measures it rather than assumes it away.

2. **Frontier-model progress erodes the premise.** Orientation cost is being removed by vendor memory, cheaper cached tokens, and built-in LSP. Mitigation: we do not sell navigation; the product is correctness (contracts, auth matrices, pitfalls) and governance (gates, impact on PRs), which matter more as agents write >80% of code. Quarterly re-run against the newest model with a "delta must not shrink faster than we ship" rule. Honest open risk: a model that writes better code also writes better tests; the argument that a human-reviewed, gate-protected contract beats a same-session agent test is plausible (different author, different time, weakening is flagged) but not yet proven; the B vs A+lib arm is the test.

3. **New languages are not adopted.** Mitigation: there is no new syntax in the first three products; the declared form is TypeScript that every editor, linter, and model handles; `.al` is a 2028 projection gated on Stage 2 and a corpus, and the IR design means it can be added without migrating a user.

4. **Abstraction leakage and expressiveness cliffs.** Real backends have joins, reports, uploads, streaming, cron, multi-entity transactions, tenant scoping. Mitigation: observe mode never forces a shape; actions that do not fit remain `Exposure` nodes with evidence and are not wrapped; a `query` construct (declared reads, no contracts beyond policy) ships in V0 so reports are not untracked; `tenant` scoping is in V0 observe mode as a policy predicate; the handler-line and opaque-guard ratios are published health metrics, and if the reference app exceeds 40% handler lines the primitive set is wrong.

5. **A platform ships this natively (Anthropic, GitHub, Cursor, Prisma Next).** Mitigation: MCP-native and cross-vendor from day one so we are a complement inside every agent; compile to Prisma rather than compete; own the benchmark and the installed PR-bot base; keep the enterprise gates on-prem-capable. If Prisma Next ships contracts on the data layer, Warrant covers actions, policies, workflows, and tests above it. Residual: a GitHub-native contract gate would hurt; speed to installed base is the only defense.

6. **Stale or wrong graph destroys trust.** Mitigation: refuse-or-rebuild on every call by content hash; never a stale answer; `evidence` on extracted nodes; refuse to answer below ~90% confidence; `read_source` always available; concurrent subagents handled by per-call rebuild rather than a watcher.

7. **Agents weaken contracts to get green.** Observed behavior, not hypothetical. Mitigation: the PR bot flags any change that weakens or removes a `requires`/`ensures`/`policy` as a separate review item; the CLAUDE.md block tells agents to state weakenings explicitly; Enterprise gates can block them.

8. **Benchmark is dismissed as vendor-run or underpowered.** Mitigation: documented control arm with CLAUDE.md + LSP, library-only and generic-graph arms, N=10, pre-registration, public logs, third-party reproduction before quoting, losses published, per-category reporting.

9. **Adoption without revenue (Prisma/Encore trap).** Mitigation: buyer-based open core from day one (anything a manager or reviewer looks at in a PR is paid; anything an engineer types is free); PR bot billing at M7; no hosted-graph product; on-prem report server so security teams can buy.

10. **Scope exceeds two people.** Mitigation: one ORM, two routers, one validator; no apply_patch, no projection printer, no ULID reconciliation, no cascade root-cause analysis beyond a diff-scoped heuristic, no workflows engine, no Studio, no Python until M12; every feature in section 9 has a month and a demo criterion, and anything not listed is a no.

## 12. Open questions the founder must decide now

1. **Name and trademark.** Pick from section 3 (or another) and clear it before the repo is public.
2. **Hono or Express first.** Design partners decide; if the first three are on NestJS, the V0 router choice changes and the extractor budget doubles. Commit to one by week 2.
3. **Is the TS-embedded form "the language"?** Decide publicly whether the company's story is "we built an agent-native language without new syntax" (then invest in semantics cards, the spec-card projection, and the contract language as first-class) or "we build contracts and impact for TypeScript" (then never mention a language). Hedging between them is the one thing the critics punished every proposal for.
4. **Observe-mode enforcement boundary.** Test-time only (recommended) or also a dev-server middleware? The latter puts a 0.x library in a request path.
5. **Design-partner terms.** Free for six months with benchmark data and a logo, or paid pilots at $10-20K that convert slower but fund the contractor? Pick one; do not assume both.
6. **Pre-seed or self-fund to M6.** The M6 number is the fundraising asset; raising before it means raising on narrative at a worse price.
7. **Third-party benchmark operator.** Identify the group (university lab or benchmark org) by month 2 so they are engaged before results exist, not after.
8. **Stage 2 target.** If the gate passes, generate into the customer's stack (Prisma + Hono, recommended) or into a canonical stack (Drizzle + Hono, as the architecture brief proposed). The former is adoptable; the latter is cleaner. Decide before Stage 2 design begins at M12.
9. **Guard policy.** Whether opaque `guard` contracts are allowed in Enterprise gate-protected entities by default, or require an explicit override. This is a product-policy decision that shapes how customers feel about tiers.

## 13. Prior-art table

| Competitor | Overlap | Differentiation |
|---|---|---|
| Encore ($6.8M seed, ~200 prod teams, OSS framework + Cloud; self-run agent-cost benchmark) https://encore.dev/articles/cheapest-framework-ai-coding-2026 | Same thesis: primitives + MCP cut agent spend; infra-from-code | Framework you must adopt vs a layer that attaches to Prisma/Hono; no contracts, no impact, no neutral benchmark |
| Convex ($110.5M, "backend for agents", TS-everywhere) https://siliconangle.com/2026/08/04/convex-reels-57m-ai-optimized-application-backend/ | Agent-optimized backend narrative | Hosted runtime with lock-in vs runtime-agnostic contracts over Postgres; we can compile to Convex later rather than compete |
| Prisma Next / create-db / Compute (contract-based model "safe to delegate to your agent") https://www.prisma.io/blog/tag/ai | Agent-safe data layer | They own schema; Warrant covers actions, policies, workflows, tests above the data layer and compiles to Prisma |
| ZenStack v3 (declarative access policy on a Prisma superset) https://zenstack.dev/blog/orm-2026 | Policy-as-schema | Row-level policy on the ORM vs action-level policy, contracts, impact, and agent tooling; complementary target for `policy` nodes |
| Supabase / Neon (agent-provisioned Postgres; Neon Agent Plan) https://neon.com/docs/introduction/agent-plan | Default DB for agent-built apps | Infrastructure, not semantics; Warrant targets their Postgres |
| Temporal / Restate / Inngest (durable execution; Temporal $12.55B) https://thenextweb.com/news/temporal-550m-series-e-12-55bn-valuation-lightspeed | Workflow/retry/queue primitives | We never build an engine; `workflow` nodes bind to theirs and add graph edges and tests |
| Augment Context Engine / Greptile / CodeGraph MCPs https://www.augmentcode.com/context-engine , https://skillselion.com/mcp/tool/io.github.codegraph-ai/codegraph | Code graph for agents, PR summaries | Heuristic retrieval vs compiler-verified contracts, effects, impact; our benchmark includes a generic-graph arm to prove the difference |
| Amazon Kiro / Google Antigravity / Tessl (spec-driven development; Tessl $125M) https://www.softwareseni.com/aws-kiro-amazons-spec-first-bet-on-agentic-development/ , https://fortune.com/2024/11/14/tessl-funding-ai-software-development-platform | Spec as source of truth | Markdown specs interpreted by an LLM vs compiled, enforced, gate-protected contracts |
| Wasp (abandoned custom DSL for TS spec, 2026) https://wasp.sh/blog/2025/12/30/wasp-2025-year-in-review | Declarative full-stack compiler | The cautionary precedent that drives our no-new-syntax decision; Wasp generates apps, we attach to them |
| Keel (schema DSL → vertical ERP services) https://www.keel.so/ | Declarative backend DSL | Pivoted to services; we stay horizontal within one vertical slice (multi-tenant SaaS APIs) and sell software |
| Jac/Jaseci (Python superset; Sigil compiles SKILL.md to enforced programs) https://buttondown.com/jaseci-newsletter/archive/jaseci-digest-05-news-from-the-jaseci-open-source/ | Semantic primitives as language constructs | Academic OSS, Python, no backend/contract focus; closest research cousin, not a commercial competitor |
| Darklang (proprietary runtime; Dark Inc out of money 2025) https://blog.darklang.com/ | Agent-era language ambition | The failure mode we are designed to avoid: no runtime, no editor, no lock-in |