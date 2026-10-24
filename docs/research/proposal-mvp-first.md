# Strategy Proposal: MVP-First, Revenue in 9 Months, Language Preserved as Option

Working name: **Lattice** (placeholder; avoid "Lang" in the company name). The thing we are building is the Semantic IR from the concept document. The language is the third projection of that IR, not the first product.

## 1. Product definition

**Positioning (one sentence):** *Lattice is the compiler-maintained semantic layer between your TypeScript backend and every coding agent: agents stop re-reading your repo, stop guessing your invariants, and you see what they changed and what it cost.*

**Ships first (V0, months 0-6), all Apache-2.0:**

1. `lattice init` on an existing TypeScript backend (Prisma or Drizzle; Express, Hono, Fastify, NestJS; Zod/class-validator) producing the IR: `.lattice/graph.sqlite` plus a committed `ir.json`. Nodes carry `origin: extracted` and `confidence`.
2. `@lattice/contracts`: a thin TS library (`defineAction`, `policy`, `requires`, `ensures`, `effects`, `intent`) that *wraps existing handlers* rather than replacing them. Wrapped nodes become `origin: declared`, confidence 1.0. The compiler derives Vitest contract tests, an auth matrix, and OpenAPI from them. Runtime enforcement in dev/test; `requires` on in prod, `ensures` sampled.
3. `@lattice/mcp`: nine tools with hard token budgets (section 3), plus `lattice --json` CLI for the same operations.
4. Structured diagnostics with cascade collapse and `explain_failure` over contract traces.
5. AgentCodeBench v0 (30 tasks) and its public harness.

**Ships second (V0.5, months 7-9), commercial:** the Lattice GitHub App and hosted graph: PR impact reports, agent-change audit trail, token-cost-per-task dashboard, multi-repo index, SSO.

**Deferred, explicitly:** generating app code (routes, schema, migrations) from declarations (Stage 2); a `.al` grammar and LSP (Stage 3, gated on benchmark); workflows and queues (will compile to Inngest/Temporal/Restate when added; never our own engine); Python; a web Studio; any hosted runtime; fine-tuned models.

The crucial choice here is that V0 *generates nothing that replaces application code*. It generates tests, OpenAPI, and the graph. That means zero round-trip problem, zero "escape hatch" design, and zero "my generated code is unreadable" objection in month 6. It also means a team can adopt it on a 60k-LOC repo in an afternoon with no rewrite, which is the Grafana/Sentry adoption pattern rather than the Encore/Hasura one.

## 2. Representation decision

**Decision: IR as the product; TS-embedded typed DSL as the first projection; Markdown spec cards as the human projection; `.al` syntax only after Stage 2 benchmark numbers justify it.**

I am overriding the architecture brief's `.al`-first recommendation, for three reasons tied to this angle. First, time: a Langium grammar, LSP, formatter, and projection printer are 4-6 weeks of a 2-person team's 26 that produce no revenue. Second, Wasp abandoned a custom DSL for a TypeScript spec with YC money and eight people; we should not relearn that. Third, the agent-cost brief's point is decisive: a model's TypeScript prior transfers to a library-shaped DSL (Zod, Drizzle, Convex are existence proofs), while a new grammar pays the full no-training-data penalty and needs the spec in every context window. The architecture brief's legitimate objection, that `tsc` diagnostics are unstructured, is solved differently: our compiler evaluates the restricted TS module with ts-morph, rejects anything dynamic, and emits *our* diagnostics in domain terms; `tsc` errors are collapsed into them.

**Human-readability guarantee, made testable:** every declared node renders deterministically to a Markdown spec card (intent, inputs, policy, requires, ensures, effects, tests, owner, last change), and `lattice docs` writes `SPEC.md` per module. The rule: *if a product manager cannot read the spec card and say whether the behavior is right, the construct is not allowed in the DSL.* `intent` is mandatory on every action; the compiler errors without it. This also gives agents a recorded decision log, which the agent-cost brief identifies as the largest irreducible cost.

**Worked example** (existing Express+Prisma repo; the agent is asked "mark invoices paid from the Stripe webhook, idempotently").

Before: `routes/stripe.ts` has a raw handler. The agent wraps it:

```ts
import { defineAction, policy, integration } from "@lattice/contracts";
import { Invoice, StripeEvent } from "../entities";

export const Stripe = integration("Stripe", {
  client: "./integrations/stripe",
  effects: ["network"], nonTransactional: true,
  pitfalls: ["raw-body-required"],          // compiler checks express.raw() on this route
});

export const MarkInvoicePaid = defineAction("Invoice.markPaid", {
  intent: "Stripe tells us an invoice was paid. Processing the same event twice must be a no-op, never a double credit.",
  input: { eventId: StripeEvent.id, invoiceId: Invoice.id, amountCents: "int>0" },
  output: Invoice,
  policy: policy.system("stripe-webhook"),  // verified signature, no human actor
  idempotent: { key: "eventId", store: "db" },
  requires: {
    invoiceOpen: ({ input, db }) => db.Invoice.exists({ id: input.invoiceId, status: "open" }),
  },
  ensures: {
    paid: ({ result, input }) => result.status === "paid" && result.paidCents === input.amountCents,
    eventEmitted: ({ events }) => events.emitted("InvoicePaid"),
  },
  effects: ["db:write", "event:emit"],
  transaction: true,
  run: markPaidHandler,                    // the existing function, unchanged
});
```

From this the compiler derives: a graph node with `calls -> Stripe`, `writes -> Invoice.status`; a diagnostic if the route lacks `express.raw()` (`L2210: integration Stripe requires raw body; route uses express.json()` with a one-line patch); generated tests for the open-invoice precondition, the paid postcondition, the idempotency replay, and the event; an OpenAPI entry; and a spec card. Nothing in the handler was rewritten.

## 3. Agent interface, day one

The MCP server runs over stdio; `lattice mcp install` writes the config for Claude Code (`claude mcp add`), Cursor (`.cursor/mcp.json`), Codex (`config.toml`), and drops a 1.5k-token section into `CLAUDE.md`/`AGENTS.md` that tells the agent the tools exist, to prefer `inspect` over `cat`, and to trust generated contract tests. Tools, each with `max_tokens` (default 1500) and cursors:

`overview`, `find`, `inspect(id, depth=0)`, `impact(id | proposed_change)`, `conventions(topic)`, `check(scope=affected)`, `explain_failure`, `trace`, `docs(construct)`, plus `read_source`/`edit_source` passthroughs so the agent is never blocked. Ids not bodies by default; depth 0 by default; session-aware deltas; no whole-graph dumps.

Diagnostics follow the brief's schema (`code, node, cause chain, related<=5, fixes[] with patch + confidence, since_last_green`). The one feature I would ship before anything else is **cascade collapse**: 40 `tsc` errors from one wrong field name arrive as one diagnostic with the root cause. `explain_failure` returns actual-vs-expected values, the fixture, and the causal chain (route -> policy -> contract -> handler line); never a stack trace. Fix suggestions are a deterministic rule table keyed on diagnostic code in V0; nothing learned.

Trust guard: every answer carries `freshness: commit sha` and the graph is rebuilt incrementally on file save; `lattice check --clean` in CI fails if `ir.json` is stale. A wrong oracle is worse than grep, so staleness is treated as a build error.

## 4. Benchmark plan and the claim it must support

AgentCodeBench v0: 30 tasks (6 per category: feature, bug fix, refactor/migration, third-party integration, ops) on one seed SaaS app at 15k and 60k LOC, with hidden HTTP-level acceptance tests and a hidden regression suite. Arms: (A) plain repo with Claude Code's built-in LSP; (B) A + Lattice graph/MCP; (B+) B with contracts declared. Three models (Claude, GPT, one open), N=5 per cell, pinned harness, pre-registered analysis, baseline app authored by a contractor outside the team, and a 10-task held-out set written after the tool is frozen. Full-cell cost is roughly 30 x 3 arms x 3 models x 5 runs = 1,350 sessions at $3-6 each, so $5-8K per run; budget two runs before launch.

**The claim the MVP must support:** *On the jointly-solved subset, Arm B+ uses at least 30% fewer input tokens and at least 30% fewer tool calls than Arm A, with pass@1 up at least 10 points on the 60k-LOC repo, across two of three models with non-overlapping 95% CIs.* Tokens alone would be a tautology; the pass-rate gain and the large-repo condition are what make the number sellable. If B captures nearly all of B+'s gain, contracts are a governance feature, not a correctness one, and we say so. If A is within 15% of B+, the premise is eroded and we pivot the asset to governance (section 7). Publish losses. Run monthly; let Encore and Convex submit.

## 5. Business model

**License:** Apache-2.0 for indexer, contracts library, compiler, MCP, CLI, benchmark; DCO, no CLA; ToS states generated output is the user's. Hosted control plane closed. Never relicense.

**Free (unlimited users):** everything local, single repo.

**Team, $25/dev/month (cap 50 seats):** hosted multi-repo graph, PR impact reports, agent-change audit trail, token-cost-per-task dashboard, shared conventions and contracts.

**Enterprise, from $60K/year (typical $60-180K):** SSO/SAML, RBAC, policy gates ("no agent PR may remove a policy or touch `Payment.*` without a contract"), VPC/on-prem at 1.5x, private benchmark runs on the customer's repos, SLA.

**First paid feature:** the GitHub App that posts, on every PR, "what changed semantically, who depends on it, which contracts are affected, which tests were generated, how many agent tokens this PR consumed." It is the thing a VP Eng or AI-enablement lead sees in their own workflow and can expense in a quarter, and it is useless without the OSS core, so it pulls adoption rather than taxing it.

**First 10 customers:** B2B SaaS companies with 50-500 engineers, a TypeScript monorepo on Prisma/Drizzle, Claude Code or Cursor on most seats, and a named owner of "AI spend" who has already been surprised by a bill. Fintech-adjacent and healthtech are preferred because the policy gate sells itself there. Offer: free Enterprise for 6 months in exchange for benchmark data and a logo; convert at $40-80K.

**18-month milestones:**

- M0-3: indexer for Prisma+Express/Hono; MCP with `overview/find/inspect/impact/check`; contracts library; benchmark v0 published with first numbers.
- M4-6: cascade-collapsed diagnostics, `explain_failure`, NestJS/Drizzle extractors; 1,000 stars, 150 weekly active repos, 3 design partners signed.
- M7-9: GitHub App + hosted graph + cost dashboard; 5 paying Team accounts; first Enterprise deal; benchmark at 60 tasks.
- M10-12: policy gates, SSO, Python indexer; 2-3 Enterprise deals, $150-250K ARR; benchmark at 100 tasks with third-party tasks.
- M13-18: Stage 2 decision from data: build the codegen layer (declarations deriving schema/routes/migrations) *only if* B+ beat A by >30% cost and >10 points pass rate. Target $400-700K ARR, 8-10 enterprise logos. Raise $1.5-2.5M seed on the benchmark number if Stage 2 is a go.

## 6. Team and cost

- **Founder (CTO-type):** IR, compiler checks, MCP server, diagnostics, benchmark design. Owns the spec card rule.
- **Senior TS engineer (hire 1, month 1):** extractors (ts-morph), contracts runtime, test generation, GitHub App.
- **Contractor, months 2-5, ~0.4 FTE:** baseline benchmark app and task acceptance tests; must be external for credibility anyway.
- **Part-time devrel/founder sales from month 5:** the founder does design-partner calls; a contractor writes docs and the monthly benchmark post.

Outsource or buy: SOC2 (Vanta, month 10+), design, auth for the hosted app (Clerk/Better Auth), payments (Stripe). Skip entirely: LSP and editor plugins (TS tooling does this for us), Studio UI, hosting, fine-tuning.

Burn: two engineers at $14-20K/month fully loaded each (less if one is founder-deferred), $3-5K contractors, $2-4K infra, and $5-8K per benchmark run every other month. **$35-50K/month**, roughly $650-900K to month 18 before revenue. Design-partner services revenue in months 7-12 covers a third of that.

## 7. Five biggest risks and how this handles them

1. **Commoditization by Claude Code LSP, Augment, Greptile, free CodeGraph MCPs.** We never compete on retrieval. The graph's defensible nodes are *declared* contracts, effects, policies, and impact, which are verified by a compiler, not inferred by heuristics. The benchmark's Arm B vs A result tells us within 3 months whether retrieval alone is worth anything; we do not need to guess.
2. **A stale or wrong graph destroys agent trust.** Incremental rebuild on save, `freshness` on every response, confidence on extracted nodes, `read_source` fallback, and CI drift check. Extracted contracts are never asserted as facts; they are `Opaque` until declared.
3. **Benchmark shows marginal gains (<15%).** Pre-committed pivot: the GitHub App, audit trail, and cost dashboard sell on visibility alone (Uber-style budget blowups are current pain). The language is dropped, the IR survives as a governance product. Decision date: month 12, no later.
4. **Adoption without revenue (Prisma/Encore trap).** Buyer-based open core from day one: anything a manager or compliance owner looks at is paid; anything an engineer types is free. Hosted stateful graph from month 7, not month 18. Every OSS feature ships with a paired paid capability.
5. **MDA-style round-trip rot and the "learn our DSL" tax.** V0 generates no application code, only tests and docs, so there is no bidirectional sync to break. The DSL is wrappers around existing functions in plain TypeScript, type-checked by `tsc`, so the tax is a `docs(construct)` call, not a spec in every context window. Codegen (Stage 2) enters only with a drift guard and a demoable eject, and only after the number exists.

## 8. Why this beats the other obvious angles

- **Language-first (`.al` + codegen in 12 weeks):** 18-30 months to revenue, no corpus, Darklang and Wasp as precedents, and it forces a rewrite on every customer. The architecture brief's plan is excellent for Stage 2; it is the wrong first product for a two-person company.
- **Pure agent-cost observability:** 3-6 months to revenue but Helicone, Langfuse, Portal26, and Splunk are already there. We take it as a *feature* of the paid tier, not the company.
- **Hosted agent-backend (Convex/Supabase lane):** needs a runtime and $100M; incompatible with the no-lock-in promise and the budget.
- **Vertical build-for-me services (Keel's pivot):** real revenue, no leverage; it abandons the thesis.
- **Spec-as-markdown (Kiro/Tessl):** the spec is interpreted by an LLM, so nothing is verifiable. Our spec is compiled and enforced, which is the one thing a compliance buyer will pay for and the big vendors have not built.

This plan takes the concept document's Stage 1 literally, adds the contract layer early because it is the only non-commoditized part of the graph, makes the benchmark the growth engine, and leaves every door to the full Agent Programming Environment open while putting paying design partners inside nine months.

---

# Critiques

## Verdict: viable-with-changes

Read as what it is: this is not a language proposal, it is a code-intelligence-plus-contracts-library-plus-GitHub-App proposal that keeps the word 'language' alive through a gate it has designed to be unpassable. That is a defensible business choice. It should be said to the founder in those words, because he asked for 'the most agent-friendly programming language' and the document's honest answer is 'do not build one; build a semantic index and a contracts runtime, and if a benchmark we cannot afford to run properly clears a three-way conjunctive bar, revisit.'

The central technical contradiction is in section 2. The proposal overrides the architecture brief's decidable `.al` expression subset in favor of TypeScript closures so that 'a model's TypeScript prior transfers', and then keeps every promise that only a decidable subset can deliver: 'generate an arbitrary via fast-check that violates exactly that clause', 'every declared node renders deterministically to a Markdown spec card', `impact(proposed_change)`, `ensures` sampled in production. A `({ input, db }) => db.Invoice.exists(...)` lambda is opaque to all of these. The escape offered ('our compiler evaluates the restricted TS module with ts-morph, rejects anything dynamic') cannot apply to the lambda bodies, which are the contracts. Pick one: a serializable contract language (JSON/builder expressions or a typed template-string mini-language with a tsc-checked wrapper) that is analyzable but has zero training data and must be specified semantically in context, or opaque closures that are familiar but turn 'verified by a compiler' into 'labelled confidence 1.0 by convention'. The second option is the stale-oracle failure the proposal itself names as 'worse than grep'. There is no third option, and the proposal pretends there is.

The second contradiction is section 1's headline: 'V0 generates nothing that replaces application code.' True of codegen, false of runtime. `defineAction` with `transaction: true`, `idempotent: { store: 'db' }`, event emission, and policy evaluation is a framework that owns the request path, needs a table in the customer's schema, and requires the 'unchanged' handler to use `ctx.db` instead of the global Prisma client. That is the Encore-style adoption cost the proposal claims to avoid, delivered with a 0.x library in the hot path of a fintech customer's webhook. Either the contracts layer is observational (checks run in test only, no transaction ownership, no idempotency store, no bus) and the 'afternoon adoption' claim survives, or it is a runtime and the proposal is Stage 2 without the generator.

The commercial leg has a hole that the research briefs did not catch: the first paid feature bills for data it cannot see. 'How many agent tokens this PR consumed' requires per-task telemetry from Claude Code, Cursor, and Codex; only Claude Code exports anything (OTel), and none of them tag tokens to a PR. The audit trail sees only `edit_source` calls, not the agent's native edits. The policy gate needs 'agent-authored' as a git fact, which it is not. Since governance is also the pre-committed pivot if the benchmark disappoints, both legs of the plan are weak at the same joint. A fixable version exists (integrate with Claude Code's OTel export only, position as 'Claude Code governance', and make the gate a semantic lint on all PRs regardless of author), but that is a different and smaller product than described.

On the benchmark: the design skeleton is the strongest part of the document and should be kept, but as specified it will not persuade anyone. 30 tasks x 5 runs against 30x same-task variance cannot produce non-overlapping CIs for a conjunctive claim across two of three models. Arm B+ is confounded by annotation; without an Arm A' that receives equivalent free documentation (CLAUDE.md, ARCHITECTURE.md, docstrings), a reviewer will attribute the gain to 'someone wrote down what the code does'. The 60k-LOC seed app with hidden suites assigned to a 0.4-FTE contractor is not going to exist, so the condition the claim depends on ('on the 60k-LOC repo') will be unmeasured. The benchmark budget ($5-8K per run, 'run monthly') is 10-15% of total burn and operationally heavy for two people. Cut to 20 tasks, N=10, one repo at 20k LOC, two arms plus A', one model first, and report tool-usage rate; a narrow credible number beats a broad incredible one.

On the team: the V0 scope is 6-8 engineer-years in 2. The support matrix (2 ORMs x 4 frameworks x 2 validators) exists only because 'attach to existing code' inherits real-world diversity; the architecture brief's narrow Stage 1 (Prisma + one router + Zod, 3 weeks) was the right instinct. Cascade-collapsed tsc diagnostics is listed as 'the one feature I would ship before anything else' and is the one most likely to consume a quarter for a heuristic a frontier model already approximates by reading the first error.

On 2027: the orientation bucket the graph attacks is the bucket every harness vendor is attacking with persistent memory, built-in LSP, and cheaper cached tokens. By the time the M12 data exists, the Arm B premise may be gone and the model vendors may have shipped a free semantic index. The durable asset, if any, is the pitfall-encoding checks and the decidable contracts: deterministic facts a harness will not build because they are domain-specific. The proposal under-invests in exactly those and over-invests in retrieval and dashboards.

Smaller items that still matter: a mandatory `intent` breaks incremental adoption and invites hallucinated intents that PMs will trust; committed `ir.json` becomes a permanent merge-conflict generator; the Team tier asks mid-size security teams to upload their domain model while the companies with the AI-spend pain will demand on-prem; the revenue timeline books Enterprise conversions three months before the free period of the design partners can end; 'let Encore and Convex submit' is impossible with one Express+Prisma seed app.

What I would fund: Apache-2.0 indexer for Prisma + Hono/Express + Zod only; a serializable contract expression subset wrapped in typed TS helpers (keep tsc for everything except the contract bodies, specify the contract semantics in a 1.5k-token card); observational enforcement (test-time only) in V0; the Stripe/raw-body class of pitfall checks as the lead feature; a 20-task, A/A'/B benchmark with one model and N=10; a GitHub App that posts semantic impact and contract coverage (not token counts) on every PR regardless of author; Claude Code-only cost telemetry via OTel as an Enterprise add-on, honestly scoped. Say to the founder that the language is a 2028 question, and that the IR, the contract subset, and the benchmark are the only things that make it askable."

### Fatal flaws
- Contracts-as-TS-closures destroy the only differentiator. The proposal makes `requires`/`ensures` arbitrary lambdas with `db` access (`({ input, db }) => db.Invoice.exists({...})`) and then claims the compiler will 'generate an arbitrary via fast-check that violates exactly that clause', render a 'Markdown spec card a product manager can read', do static `impact`, and sample `ensures` in production. None of that is possible on an opaque closure. The architecture brief's decidable expression subset was the thing that made contracts analyzable; the proposal dropped it for 'the model's TS prior' and kept all the downstream promises. 'Our compiler evaluates the restricted TS module with ts-morph, rejects anything dynamic' does not cover lambdas: a lambda is the dynamic part. Either you restrict closures to a tiny subset (then tsc gives you no help enforcing the restriction and you are back to a DSL with zero training data, just hidden inside TS), or you accept opacity and lose test-gen, spec cards, impact, and 'verified by a compiler, not inferred by heuristics'. The 'declared' nodes become comments with a `confidence: 1.0` label, which is the stale-oracle failure the proposal itself calls worse than grep.
- The first paid feature cannot see the thing it bills for. The GitHub App promises 'how many agent tokens this PR consumed' and a 'token-cost-per-task dashboard'. The MCP server never sees the agent's token usage; only the harness (Claude Code, Cursor, Codex) does, and Cursor and Codex do not expose per-task spend to a third-party MCP tool. Likewise the 'agent-change audit trail' only observes edits routed through `edit_source`; Claude Code's native Edit tool bypasses it entirely, and 'prefer inspect over cat' in CLAUDE.md is advisory. The 'policy gate: no agent PR may touch Payment.*' needs to know a PR is agent-authored, which git does not record reliably. The entire governance leg, which is also the declared pivot if the benchmark fails, rests on data the product cannot obtain.
- 'Generates nothing that replaces application code' is false in substance. `@lattice/contracts` is a runtime inserted into the production request path: it owns the transaction (`transaction: true`), an idempotency table (`idempotent: { key, store: 'db' }` requires a migration in the customer's Prisma schema), an event bus (`events.emitted('InvoicePaid')` on an app that has no bus), and policy evaluation. 'The existing function, unchanged' cannot be true when the handler uses the global Prisma client and the wrapper owns a transaction; the handler must be refactored to take `ctx.db`. This is Stage 2's runtime without Stage 2's generator, with all of its lock-in and production-outage surface ('a bug in defineAction is a prod outage in fintech') and none of its leverage. It also kills 'adopt a 60k-LOC repo in an afternoon': the extracted-only graph is, by the proposal's own admission, commoditized, and the differentiated layer requires wrapping every handler plus a mandatory `intent` on each ('the compiler errors without it').
- The go/no-go benchmark is both underpowered and confounded, and the gate it sets is one the language can never pass. 30 tasks x N=5 with the brief's own 30x same-task variance will not yield non-overlapping 95% CIs on a conjunctive claim (30% fewer input tokens AND 30% fewer tool calls AND +10 pass@1 at 60k LOC across two of three models). Arm B+ ('contracts declared') compares an annotated repo against an un-annotated one, which measures the value of documentation; without an Arm A' that gets equivalent CLAUDE.md/ARCHITECTURE.md/docstrings for free, no skeptic will attribute the gain to Lattice. The 60k-LOC seed app with hidden HTTP acceptance suite, hidden regression suite, and 30 tasks is assigned to a 0.4-FTE contractor over four months; that is not a deliverable, so the headline condition ('on the 60k-LOC repo') will be measured on a 15k repo where the brief predicts 10-20% gains. Net effect: Stage 2/3 is 'gated on data' that will never clear the bar, so the honest statement is 'we are not building a language', which should be said to the founder.
- Scope is 6-8 engineer-years scheduled into 2 engineer-years alongside founder sales. V0 (months 0-6, two people) lists: extractors across Prisma+Drizzle x Express/Hono/Fastify/NestJS x Zod/class-validator; a contracts runtime with transactions, idempotency, event bus, policy; property-test generation and an auth matrix; OpenAPI derivation; nine budgeted MCP tools with session-aware deltas; cascade-collapsed tsc diagnostics (root-cause attribution over type errors is an open problem, not a feature); trace-based `explain_failure`; and a three-model benchmark with two seed repos. Months 7-9 add a GitHub App, hosted multi-repo graph, SSO, and a cost dashboard. 'Attach to existing code' is cheap to adopt precisely because it is expensive to build: you inherit the full diversity of real repos. Grafana and Sentry attached through a tiny stable SDK, not through static analysis of arbitrary codebases.

### Weak assumptions
- That a TS-embedded library escapes the no-training-data problem because 'Zod, Drizzle, Convex are existence proofs'. Those are existence proofs for libraries with millions of repos in training data. A 0.x library with 200 repos has zero prior and a weekly-changing API, which is the brief's own top failure class ('misremembered library versions'), now at its worst. The syntactic tax is gone; the semantic tax (what does `idempotent.store: 'db'` do on replay, when does `ensures` run relative to commit, is `effects` checked or decorative) is untouched and the proposal does not define any of these semantics.
- That the orientation cost bucket (25-55% of spend in the brief) will still exist in Oct 2027 when the data arrives. Every harness vendor is shipping persistent cross-session memory (Codex memory, Antigravity Knowledge Items, Claude Code memory and built-in LSP), prompt caching already makes re-reads cheap, and per-token prices halve roughly yearly. Arm B is on a 12-18 month clock and the pivot leg (governance) has the data-access hole above.
- That 'AI enablement lead with a surprising bill' buys from a two-person vendor. That buyer's budget is model spend and their reflex is Claude Code Enterprise / GitHub Copilot admin dashboards / Cursor Business, all of which already show per-user spend and are inside procurement. Fintech and healthtech, the proposal's preferred verticals, run 6-9 month security reviews for anything that (a) sits in the request path and (b) sends the domain model (entities, contracts, intents) to a startup's cloud; SOC2 is scheduled for month 10+. 'First Enterprise deal by month 9' is not credible there.
- That the Team tier has a buyer. $25/dev capped at 50 seats requires shipping your semantic graph to a hosted service, which is exactly what small companies tolerate and mid-size security teams refuse; the companies with the AI-spend pain are the ones that will demand on-prem (Enterprise only). Greptile ($30), CodeRabbit ($15-24), and GitHub Copilot code review already post PR change/impact summaries, so the GitHub App is undifferentiated unless contracts are declared, which reintroduces the annotation tax.
- That committing `ir.json` is workable. A generated JSON with ULIDs and version counters for a 60k-LOC repo changes on every PR; concurrent PRs will conflict in it constantly (a lockfile that is worse than a lockfile). Gitignore it and you lose 'diff in PR'; commit it and you tax every merge.
- That the revenue timeline is arithmetically possible. Design partners signed at months 4-6 on 'free Enterprise for 6 months' cannot convert before months 10-12, yet the plan books 'first Enterprise deal' at month 9 and $150-250K ARR at month 12. 'Design-partner services revenue covers a third' of $650-900K burn also contradicts giving those partners the product free and uses the same two engineers' hours that the roadmap already consumes twice.
- That a mandatory `intent` field is a feature. On an extracted repo with 400 handlers nobody writes 400 intents; the agent will, and a confidently hallucinated intent is the one artifact a PM will read and trust. Mandatory-at-compile-time breaks incremental adoption outright.
- That 'cascade collapse' is implementable beyond heuristics. tsc does not expose causality between errors; 'group by first symbol and first error wins' is what a frontier model already does when it reads the first error. Expect marginal measured value and a disproportionate share of engineering time.
- That agents will use the tools. In practice CLAUDE.md instructions like 'prefer inspect over cat' are ignored a substantial fraction of the time under long contexts; Arm B results will be dominated by tool-usage rate, which the benchmark plan does not report.
- That 'let Encore and Convex submit' is meaningful with a single Express+Prisma seed app. Convex has no Postgres/HTTP router; a comparable arm requires a behaviorally equivalent reimplementation, which the research brief calls 'non-negotiable and expensive' and the proposal does not budget.

### Keep
- IR as the product, with the language demoted to a third projection; this is the correct reframe of the founder's concept and should be stated plainly rather than hidden behind a gate.
- No generated application code in V0 (tests, OpenAPI, docs, graph only), eliminating the MDA round-trip problem; keep this, but make it true by also keeping the runtime out of the production request path.
- Attach-to-existing-repo adoption (Grafana/Sentry pattern) instead of rewrite-to-adopt (Encore/Hasura/Darklang pattern), narrowed to one ORM and one framework for V0.
- Apache-2.0 core, DCO not CLA, explicit 'generated output is yours', never relicense; and buyer-based open core where anything a manager or compliance owner looks at is paid.
- The benchmark design skeleton: A/B/B+ arms to attribute gains to graph vs contracts, external-authored baseline, held-out tasks written after freeze, pre-registered analysis, reporting on the jointly-solved subset, publishing losses. Add Arm A' (docs-equivalent baseline) and report tool-usage rate.
- Freshness sha on every answer and staleness as a CI build error; the 'wrong oracle is worse than grep' principle.
- Hard per-tool token budgets, ids-not-bodies, depth 0 by default, cursors, no whole-graph dumps; `explain_failure` returning actual-vs-expected plus a causal chain instead of a stack trace.
- Pitfall-encoding checks on integrations (the `express.raw()` / Stripe raw-body diagnostic with a one-line patch). Deterministic, cheap, immediately valuable, and exactly where the brief says third-party failures come from. This is the best single feature in the document.
- `intent` as a recorded decision log (as an optional field surfaced in `inspect`), because re-asking resolved ambiguities is the one cost no representation removes.
- A pre-committed pivot date and a pre-stated pivot target, even though the pivot target itself needs fixing.

## Verdict: viable-with-changes

## Evaluation from the agent's seat (Claude Code, backend tasks on a 15-60k LOC TS repo)

### Would this make me faster, cheaper, more reliable than TS + rg + LSP + a good CLAUDE.md?

Partially, and in a different place than the proposal thinks. Honest decomposition of where my cost actually goes on a medium repo today:

- Orientation: I re-derive "where are routes registered, what's the auth shape, what does the schema look like" every session. But on repos with a maintained CLAUDE.md (which any team that will pay $60K/year already has), this is 5-10 tool calls, not 20. `overview` + `conventions` would shave maybe half of that. Worth having, not worth the company.
- Reads: the proposal leans on "reads are 76% of tokens, so `inspect` returning ids-not-bodies saves reads." This is the weakest link in the agent-cost argument. For any task where I modify code (which is almost all of them), I need the bodies to write an Edit. `inspect(id)` becomes an extra call before `read_source`, not a replacement. Where ids-not-bodies genuinely wins is on the periphery: callers, dependents, tests to run, "does anything else write Invoice.status". That is the `impact()` use-case, not the `inspect()` use-case. I'd reframe: the graph's job is to shrink the set of files I open, not to replace opening them.
- Fix loop: this is where I'd actually save. 40 cascading tsc errors from one wrong field name costs me 3-8k tokens of reading plus one or two wasted edit rounds. Cascade collapse plus `since_last_green` is the single most valuable feature in the proposal and I'd ship it before any graph tool.
- Verification: generated contract tests I'm told to trust would change my behavior: I currently re-edit passing code and distrust tests because I don't know what they cover. A `check(scope=affected)` that says "7 contract tests + 3 existing tests cover your change, all green, done" ends sessions earlier. That is real money.

Net: on a 60k-LOC repo with a good CLAUDE.md, I'd estimate 15-30% fewer tokens and perhaps 1 fewer iteration per task from B+, with most of it from diagnostics + affected-test scoping, not from retrieval. The proposal's 30%/30%/+10 points claim is at the optimistic edge, and only reachable if Arm A is a bare repo without CLAUDE.md, which would make the result non-credible.

### Where I'd still burn tokens (and where new costs appear)

1. Handler bodies are unchanged, so understanding the actual logic costs the same as today.
2. Third-party semantics (Stripe idempotency, event ordering) are still mine to know. The `pitfalls` idea helps only where someone encoded it.
3. Test infra: fixtures, env, pglite vs real Postgres differences, flaky property tests. Generated fast-check tests against a DB will produce counterexamples with random data that the contract author never intended. I will then do the expensive and wrong thing: loosen the `ensures` so the test passes. The proposal needs a rule, enforced by the compiler/PR gate, that an agent change which weakens a contract is flagged as a separate review item. This is both a correctness guard and a sellable governance feature.
4. Learning `@lattice/contracts`: I'll read the `.d.ts` once per session (~1-2k tokens) plus `docs()` calls. Fine if the API is small and typed; expensive if it has string mini-DSLs (see below).
5. MCP overhead: 11 tools at 200-500 tokens each is 3-5k tokens of schema in every turn, plus the 1.5k CLAUDE.md section. That is 5-6k tokens before I do anything, and it must be charged to arms B/B+ in the benchmark. Consolidate to about 6 tools and serve `docs` as an MCP resource, and ship the CLI `--json` as a first-class path, because when I'm already in a Bash loop I compose CLIs and skip schema overhead.
6. Session-aware deltas ("you already inspected these 6 nodes") will hurt me, not help: after context compaction or in a subagent, I no longer have what the server thinks I have. Make deltas opt-in via an explicit `seen=[ids]` parameter; never suppress by default.

### Where the DSL gets in my way

**The "wrap existing handlers unchanged" claim is not true for the target repos.** Express/Fastify/Nest handlers take `(req, res)` or a DTO and write to `res`; they don't return a domain object, and they don't receive a transaction client. `ensures: ({ result }) => result.status === "paid"` has no `result`. `transaction: true` can't wrap Prisma calls inside a handler that imports its own client. So to use `defineAction` I must refactor every handler into a returning function on `ctx.db`. That's the Encore/Hasura adoption pattern the proposal explicitly says it is avoiding. Fix: ship two wrapper modes. `defineAction` for refactored, full-semantics actions, and `observe(route, { requires, ensures })` that asserts contracts at the HTTP boundary (request body / response body / DB before-after snapshots) with zero handler changes. The second one is what makes "adopt on a 60k repo in an afternoon" honest, and it's what I'd use first.

**Contracts as TS lambdas lose decidability, and the proposal silently traded away the architecture brief's biggest asset.** The arch brief had a small decidable expression language from which the compiler could derive fast-check arbitraries, the auth matrix, and `writes -> Invoice.status` edges. The proposal's `requires: ({ input, db }) => db.Invoice.exists(...)` is opaque to ts-morph: the compiler cannot generate a counterexample that violates exactly that clause, cannot build an allow/deny table from `policy.allow(({actor}) => ...)`, and cannot derive effect edges. What remains is "call the action, check the lambda returned false/true", which is a runtime check, not compiler-verified ground truth, and the "verified graph facts, not heuristics" differentiation evaporates. Pick one: either a tiny typed combinator subset (`field("status").in(["open"])`, `exists(Invoice, { id: input.invoiceId })`) that ts-morph can lower to IR, with raw lambdas allowed but marked `opaque`, or be honest that contracts are runtime assertions and generate tests only from the typed input schema, policy table, and idempotency declaration.

**Mixed idioms invite hallucination.** The worked example has three type systems in one object: `StripeEvent.id` (reference), `"int>0"` (string DSL), and Zod-like intent. I will guess at `"int>0"` vs `"int > 0"` vs `"positiveInt"`. Use Zod for inputs (I know it cold, tsc catches errors), make every option key a literal union type (`store: "db" | "redis"`, `pitfalls: ("raw-body-required" | ...)[]`), and never introduce a string grammar. With that, my syntax error rate on a library-shaped DSL is low (comparable to Drizzle/Convex); without it, I'll hallucinate option values and only find out at runtime.

**Expressiveness cliffs.** Streaming responses, file uploads, SSE/websockets, cron jobs, GraphQL resolvers, multi-write handlers that intentionally span transactions, and tenant-scoped queries are all outside the request/response-with-one-return shape. In a real 60k repo, 20-40% of handlers won't fit. I need a documented answer ("these stay unwrapped; the graph shows them as `Opaque` with evidence") so I don't waste a session trying to force them in.

**`db` in the lambda**: is it the Prisma client, or a Lattice shim? If a shim, that's a second ORM API to learn and a leak. Pass the project's own client (or tx) and nothing else.

### Diagnostics and the debugger: signal or noise?

- Cascade collapse + `since_last_green`: signal, highest value. But collapsing arbitrary tsc output is a heuristic (group by first-introduced symbol in the diff); say so and ship the heuristic version early rather than promising root causes.
- `fixes[]` with confidence: cap at two, show only >= 0.7, and give the patch as an applyable diff. Low-confidence fixes are noise that I'll sometimes apply.
- `explain_failure` with actual-vs-expected, fixture, and causal chain: signal. Two additions I'd want: (a) the failing contract's declaration site and author/commit, so I can decide "my code is wrong" vs "this contract is wrong, flag it", and (b) the generated test's input in a form I can paste into a reproduction. Omitting stack traces is right, but keep a `handle` to fetch one.
- Static checks like "route uses express.json() so raw body is consumed": middleware ordering in Express is often dynamic (routers mounted conditionally, app-level json()). A false negative here is worse than no check because I'll trust it. Implement these as runtime/test-time checks (the generated webhook test sends a signed raw body and asserts verification passes) rather than static analysis.
- `confidence: 0.8` on extracted nodes is not actionable. Give me `evidence: "routes/stripe.ts:12 app.post literal"` so I verify in one read.
- Freshness: "rebuilt on file save" doesn't exist when I edit through tools. Rebuild on demand per call via content hashes; return `stale: true` + sha rather than refusing. Also handle multiple concurrent subagents editing the same repo.

### Benchmark

The 2x2 and pre-registration are right. Three things would make me, as a skeptic, dismiss the number:
1. Arm A must have a maintained CLAUDE.md/AGENTS.md with conventions and LSP on. Otherwise B's "orientation" gain is just "we wrote the docs."
2. Add an arm "A + a free generic CodeGraph MCP" so the retrieval delta is separated from the semantic delta; that's the arm that tells you whether contracts are worth building.
3. Ceiling effects: frontier pass@1 on well-specified backend tasks is already high; +10 points at 60k LOC requires genuinely hard tasks (cross-cutting, policy-sensitive). Design the task set to be hard enough that A scores 50-70%, or the pass-rate claim can't be shown.
Also charge the 5-6k tokens of MCP schema + CLAUDE.md section to the B arms, and budget $5-15/session for Claude on 60k-LOC tasks, not $3-6.

### What I'd change, in priority order

1. Two wrapper modes (`observe` at HTTP boundary, `defineAction` refactored); make the afternoon-adoption claim true.
2. Restricted typed combinators for contracts/policies so the compiler can actually derive tests, auth tables, and effect edges; raw lambdas allowed but marked opaque.
3. Zod inputs, literal-union options, no string DSLs, tiny option surface.
4. Ship cascade collapse + since_last_green + affected-test `check` first; graph tools second.
5. On-demand rebuild with staleness flag; drop session-aware deltas by default.
6. `evidence` instead of `confidence`; fix suggestions capped and thresholded.
7. Consolidate to ~6 MCP tools + CLI --json; docs as resource.
8. A compiler/PR-gate rule: agent patches that weaken or remove contracts are flagged separately. This is both the thing that stops me from "fixing" tests by loosening ensures and the first governance feature an enterprise will understand.
9. Agent-driven adoption: `lattice propose` where I draft `intent`/contracts from existing handlers and humans approve spec cards in a PR. That's how contract density grows past the first five actions, and it's a workflow a compliance buyer pays for.
10. Fair Arm A in the benchmark, plus a generic-graph arm.

With those, I'd expect the product to genuinely cut my fix-loop and verification cost and end sessions earlier. Without 1 and 2, it's a code-graph MCP with runtime asserts, and the free alternatives plus Claude Code's LSP are close enough that I'd not reach for it.

### Fatal flaws
- The 'wrap existing handlers unchanged' adoption story is false for the target stacks: Express/Fastify/Nest handlers take (req,res), return nothing, and own their DB client, so `ensures({result})` and `transaction: true` require refactoring every handler into a returning function on ctx.db. As written, V0 reintroduces the Encore/Hasura rewrite tax it claims to avoid. Needs an HTTP-boundary `observe` mode with zero handler changes.
- Switching contracts from the architecture brief's decidable expression subset to opaque TS lambdas destroys the differentiator: the compiler cannot derive counterexample inputs, auth allow/deny matrices, or reads/writes edges from `({input, db}) => db.Invoice.exists(...)`. 'Compiler-verified facts, not heuristics' silently becomes 'runtime assertions', which is what free code-graph MCPs plus a test framework already give. Needs a small typed combinator subset that ts-morph can lower to IR, with raw lambdas marked opaque.
- The benchmark claim is unfalsifiable as designed: if Arm A is a bare repo, the 30%/30%/+10pt result mostly measures 'we wrote the docs' and nobody credible will accept it; if Arm A has a maintained CLAUDE.md + LSP (which paying customers already have), the retrieval gains largely vanish and the 10-point pass@1 gain hits ceiling effects on frontier models. The go/no-go for Stage 2 and the seed raise are both pinned to this number.

### Weak assumptions
- 'Reads are 76% of tokens so inspect(ids-not-bodies) cuts reads': for any modify task I need the body to write an Edit, so inspect is an extra call before read_source, not a replacement; the real savings are in impact() shrinking the set of files opened.
- Agents will prefer inspect over grep because CLAUDE.md says so: I revert to rg/Read whenever a tool answer looks incomplete or I need to verify; a 1.5k instruction block changes behavior only partially.
- Cascade collapse over arbitrary tsc output is implementable in V0: tsc gives no root causes; only a diff-scoped heuristic (group by first-introduced symbol) is feasible, and it should be sold as such.
- Static detection of pitfalls like 'route uses express.json() so raw body is lost': Express middleware ordering is frequently dynamic; a false negative here is worse than no check. Do it as a generated runtime test instead.
- 'Graph rebuilt on file save': agent tool edits produce no editor save events; must rebuild on demand per call by content hash and handle concurrent subagents.
- Session-aware deltas help: after context compaction or in subagents the server's model of what I've seen is wrong; suppressed info is lost, not saved.
- Generated fast-check property tests against pglite will be trusted: they are slow, produce unintended counterexamples, and will push me to loosen ensures to make them pass, unless weakening a contract is flagged by a gate.
- A string mini-DSL inside TS (`amountCents: "int>0"`, `pitfalls: ["raw-body-required"]`) has low hallucination risk: it does not; only Zod inputs and literal-union option types get tsc to catch my mistakes.
- A `confidence: 0.0-1.0` field on extracted nodes is actionable: it isn't; `evidence: file:line + how it was found` is.
- $3-6 per benchmark session: realistic for 15k LOC; 60k-LOC tasks on Claude with 30-70 tool calls run $5-15, roughly doubling the benchmark budget.
- Eleven MCP tools at ~1.5k-token cap each are cheap: the schemas alone cost 3-5k tokens per turn, plus the CLAUDE.md section, which must be charged to arms B/B+.
- Mandatory `intent` on every action produces a usable decision log: with no review gate it produces boilerplate ('marks invoice paid'); the value comes only if PMs/humans actually review the spec cards.
- `db` inside contract lambdas is the project's own client: if it is a Lattice shim it is a second ORM API to learn and an abstraction leak.

### Keep
- IR as the product with a TS-embedded typed DSL as the first projection; no .al grammar until benchmark data justifies it (model priors transfer, tsc + LSP catch my mistakes for free).
- V0 generates no application code, only tests, OpenAPI, spec cards, and the graph: no round-trip problem, no escape-hatch design, no 'unreadable generated code' objection.
- Cascade collapse of diagnostics plus a `since_last_green` diff in every diagnostic: the single feature that would most reduce my wasted iterations today.
- `check(scope=affected)` returning structured results with 'these N contract tests cover your change': lets me stop re-editing passing code and end sessions earlier.
- `impact(id | proposed_change)` with affected nodes, tests to run, migration-needed, and API-breaking flags: the one graph query I cannot get from LSP references alone.
- `conventions(topic)` with one canonical example and autofix: removes the reviewer round-trip where I learn 'this repo uses Result types' too late.
- `intent` as a recorded field on every action: the decision log that stops me re-asking the same ambiguity questions across sessions.
- Pitfall-encoded integrations (raw body, idempotency keys, cursor pagination) as generated tests: third-party integration failures are exactly where my iterations go.
- Freshness sha on every response and a CI drift check that fails on a stale ir.json: a wrong oracle is worse than grep, and the proposal treats that seriously.
- read_source/edit_source passthroughs and a CLI with --json: I am never blocked when the semantic tools are insufficient, and I can compose in Bash without schema overhead.
- The 2x2 benchmark design with pre-registration, held-out tasks authored after freeze, externally-authored baseline app, jointly-solved-subset reporting, and publishing losses.
- Buyer-based open core with the GitHub App PR impact report as the first paid feature: it sits in the human's workflow, pulls OSS adoption rather than taxing it, and is expensable in a quarter.
- Pre-committed pivot to governance if the benchmark shows <15% gain, with a hard decision date: the asset survives even if the language thesis does not.
- The implied governance rule that agent changes which weaken or remove contracts are flagged: it follows directly from how I actually behave when a contract test fails, and it is the first thing a compliance buyer will understand.

