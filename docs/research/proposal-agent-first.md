# Strategy Proposal: Agent-First / Technical Purity Angle

**Thesis:** the thing that most reduces Agent Task Cost is not a shorter syntax or a better code search; it is a representation in which the classes of error agents actually make (layer mismatches, unknown invariants, unscoped auth, third-party pitfalls, noisy failure signals) are either impossible or collapse to one structured diagnostic with a patch. Build that representation, prove it with a benchmark no one can accuse of being vendor-rigged, and sell governance on top. Everything below is derived from that.

## 1. Product definition

**Ships first (V0, 12 weeks):** one npm package family, `@lattice/*` (working name; avoid "Lang" in the company name per the commercial brief):

- A **TypeScript-embedded declarative layer** (`entity`, `action`, `policy`, `event`, `workflow`, `service`, `integration`) that the compiler evaluates into a **Semantic IR** (typed property graph with ULIDs, contracts, effects, ownership, intent, history).
- A **compiler** that derives Drizzle schema + migrations, Zod validation, Hono routes + OpenAPI, pg-boss workflows, the `defineAction` pipeline (validate → authorize → requires → tx → handler → ensures → emit), and **generated contract/auth-matrix tests**.
- An **MCP server + CLI `--json`** exposing the IR with hard token budgets, cascade-collapsed diagnostics, `impact`, and `explain_failure` over runtime traces.
- **AgentCodeBench v0** (30 tasks, 2x2 arms, three models), published with the first release.
- A `saas-starter` example (orgs, members, invites, RBAC, Stripe webhook) that is also the benchmark seed app.

**Deferred:** bespoke `.al` syntax (kept as a later projection), Stage 1 extractor for arbitrary TS repos (narrow Prisma+Express only, and only with a third person), Studio UI, hosting, Python, Rust/WASM, Redis, learned fix ranking, fine-tuned models.

**Positioning (one sentence):** *The backend representation coding agents cannot get subtly wrong: declare entities, actions, contracts and policies in TypeScript; the compiler derives the rest and tells any agent exactly what exists, what depends on it, and why it failed.*

## 2. Representation decision: IR as the product, TS-embedded DSL as the day-one projection

The architecture brief argues for a custom `.al` grammar; the agent-cost and prior-art briefs argue for TS-embedded. From an agent-cost standpoint the choice is not close. The single largest *added* cost in the concept is the no-training-data tax: 70-85% first-try syntactic correctness from an in-context spec, with the worse failure being *semantic* unfamiliarity (compiles, wrong). A TS-embedded form inherits billions of tokens of prior, the LSP for free, and Zod/Drizzle/Convex/Encore.ts as existence proofs that agents handle library-shaped DSLs well. Wasp abandoned its DSL for exactly the tooling reason. We should not pay that tax before the benchmark has proven the representation is worth it.

The architecture brief's valid objection (tsc becomes the semantic analyzer, diagnostics come out in TS terms) is solved by **not using tsc as the semantic analyzer**: the compiler *evaluates* the declaration module in a sandbox (a restricted subset: top-level `export const X = action(...)`, no dynamic computation, rejected otherwise) and lowers the resulting object literals directly into IR with stable node identity and source ranges. Domain checks (policy coverage, contract well-formedness, effect consistency, migration safety) run over the IR and emit domain-level diagnostics. tsc is only used to type-check handler bodies and contract lambdas against generated types. So: **IR is the source of truth conceptually; TS-embedded is the primary projection; a read-only Markdown projection (`alc docs`) is the human/PM view; `.al` is a possible third projection once a corpus exists.**

**Human-readability guarantee (enforced, not aspirational):** one construct per concept; one spelling each; `intent:` is a required field on every `action` and `entity` (a compiler error if missing, because it is the one thing agents cannot derive and the thing PMs most need to read); contracts are a decidable TS-subset expression language; deterministic formatting, one field per line; the `alc docs` projection is tested to render every action as `intent / who may / preconditions / postconditions / effects` in under 15 lines. If a PM cannot read the Markdown projection, the construct is wrong.

**Worked example: Stripe `invoice.paid` webhook → mark invoice paid → emit event → workflow**

```ts
// billing/invoicePaid.ts
import { action, event, workflow, policy, integration, step } from "@lattice/core";
import { Invoice, Subscription, Money } from "../entities";

export const Stripe = integration("Stripe", {
  client: "./integrations/stripe.ts",
  effects: ["network"], nonTransactional: true,
  webhook: { verify: "stripe-signature", rawBody: true }, // pitfall encoded
});

export const InvoicePaid = event("InvoicePaid", {
  payload: { invoiceId: Invoice.id, amount: Money },
});

export const MarkInvoicePaid = action("Invoice.markPaid", {
  intent: "Stripe tells us an invoice was paid. Idempotent on stripeEventId; a second delivery is a no-op, not an error.",
  input: { stripeEventId: Stripe.EventId, invoiceId: Invoice.id, amount: Money },
  output: Invoice,
  policy: policy.system(Stripe),            // only the Stripe webhook may call this
  idempotent: { key: "stripeEventId" },      // compiler generates dedupe table + test
  requires: {
    amountMatches: ({ input, self }) => self.total.equals(input.amount),
  },
  ensures: {
    paid: ({ result }) => result.status === "paid",
    eventOnce: ({ events }) => events.emittedExactly(InvoicePaid, 1),
  },
  effects: ["db:write"], transaction: true,
  run: async ({ self, db, emit, input }) => {
    const inv = await db.Invoice.update(self.id, { status: "paid", paidAt: db.now() });
    emit(InvoicePaid, { invoiceId: inv.id, amount: input.amount });
    return inv;
  },
});

export const ActivateOnPaid = workflow("ActivateOnPaid", {
  on: InvoicePaid,
  steps: [step.call(Subscription.activate, ({ payload }) => ({ invoiceId: payload.invoiceId }))],
  retry: { attempts: 3, backoff: "exponential" },
});
```

From this the compiler derives: `POST /webhooks/stripe` with raw-body signature verification (the #1 real-world Stripe integration failure, encoded once), the idempotency table and migration, Zod input schema, OpenAPI, the pg-boss consumer, and tests: duplicate-delivery is a no-op, `amountMatches` violation returns `PreconditionFailed{contractId}`, non-Stripe caller gets 403, happy path asserts `ensures` and exactly one event. A PM reads `intent`, `requires`, `ensures`. An agent that wants to add "refuse if invoice is already void" calls `apply_patch add-contract` or edits one line; either way the IR regenerates.

## 3. Agent interface: works with Claude Code, Codex, Cursor on day one

Transport: MCP over stdio (all three clients) plus `alc <tool> --json` for agents that compose CLIs. `alc init` writes a **1.5k-token core spec into AGENTS.md / CLAUDE.md** (progressive disclosure; `docs(construct)` for the 300-token semantics card on demand), so the language semantics are in context without crowding the task. Nine tools, `max_tokens` enforced server-side with cursors, ids-not-bodies by default:

`overview` (≤1.5k, once per session) · `find(query, kind)` (one line per hit) · `inspect(ref, depth=0)` (signature, contract, policy, effects, callers/callees as ids, tests, owner, intent, last change) · `impact(ref | patch)` (affected nodes with *why*, tests to run, migration y/n, API-breaking y/n) · `conventions(topic)` · `apply_patch(ops, dryRun)` (projected text diff + diagnostics) · `check(scope="affected")` (typecheck + lint + only affected generated and hand-written tests) · `explain_failure(testId | traceId | diagId)` · `docs(construct)`. Plus `read_source` / `edit_source` passthroughs; `edit_source` refuses `@generated` files.

**Diagnostics** are ≤300 tokens, cascade-collapsed to a root cause (40 tsc errors from one wrong field name arrive as one), and carry `cause[]` (the fact violated), `related[]`, `fixes[]` as IR patch ops with confidence, and `since_last_green`. Error signatures map deterministically to repair strategies (the RustAssistant lesson that feedback alone plateaus). **`explain_failure`** returns actual-vs-expected values, the triggering fixture, the causal chain action → policy → contract → handler line, the structural diff since last green, and ≤3 ranked hypotheses; never a stack trace.

Trust rule: the graph is regenerated on every build (incremental, target <500 ms), and every answer carries a `source` handle so the agent can verify. A stale oracle is worse than grep.

## 4. Benchmark plan and the claim it must support

AgentCodeBench, exactly as the agent-cost brief designs it: 100 tasks (v0: 30) across feature/bugfix/refactor/integration/ops; hidden HTTP-level acceptance tests plus hidden regressions; three repo sizes; baselines in Express+Prisma, NestJS+Prisma, Encore.ts, Convex, and ours, **written or audited by people outside the team** and all passing the same acceptance suite before any run. The 2x2 arms (baseline / baseline + our graph MCP / ours without graph / ours with graph) are non-negotiable because they make results attributable: if arm B captures most of the gain, the graph is the product and the language is not. Three models (Claude, GPT, one open model), two harnesses (Claude Code, OpenHands), N=5 per cell, 95% CIs, DSL spec tokens charged to our arms, pre-registered analysis, and a held-out task set authored after primitives are frozen.

**The claim we must be able to make, or we pivot:** ≥15 absolute points pass@1 with non-overlapping CIs across all three models, ≥30% fewer tokens on the jointly-solved subset (input and output reported separately), syntactic-error rate reported separately, and no regression in blinded readability. A token win at equal pass rate is not enough; it is reproducible by writing less code. Publish losses. Run monthly; accept external submissions. The benchmark is citable even if the language dies, and it is the only growth asset a two-person team can afford.

## 5. Business model

**License:** Apache-2.0 for compiler, runtime, IR, MCP server, CLI, LSP, benchmark harness; DCO not CLA; explicit FAQ that generated code is unencumbered. Never relicense. Commercial layer (control plane) closed.

**Free, forever:** everything a single developer or small team needs locally, unlimited users, single repo, generated tests, local trace store.

**Paid line is drawn at governance and multi-repo state** (buyer-based open core: IC features free, manager/compliance features paid):

- **Team, $25/dev/month:** hosted multi-repo IR registry (cross-repo `impact`), impact reports as PR comments, token/cost-per-task dashboards, shared conventions and private primitives.
- **Enterprise, from $60K/year (typical $60-250K):** SSO/SAML, RBAC, **audit log of every agent patch with the diagnostics it resolved**, **policy-as-code gates** ("no agent patch may remove a `policy` or weaken a `requires` on entities tagged `payment`"), VPC/on-prem (1.5-2x), compliance packs later, private benchmark runs on the customer's codebase.

**First paid feature (month 7):** agent-change audit trail + policy gates + cost dashboard, because that is the thing an AI-enablement lead can expense this quarter, and it is what no model vendor will build neutrally.

**First 10 customers:** B2B multi-tenant SaaS companies, 30-300 engineers, TypeScript monorepos on Postgres, heavy Claude Code/Cursor usage with a named AI-enablement owner, building new services (greenfield is where a representation wins; we do not promise migration of legacy code in year one). Five become design partners: free Enterprise for six months in exchange for benchmark data on their real tasks and a logo; convert at $30-80K.

**18-month milestones:** M3: V0 public, AgentCodeBench v0 with the 2x2 numbers published, honest. M6: 1,000 stars, 150 weekly active projects, 3 design partners, benchmark at 60 tasks, `tenant` primitive. M9: hosted registry + audit + dashboards, 5 Team accounts, first Enterprise deal. M12: 100-task benchmark across three models, 2 Enterprise deals ($100K+ combined), narrow Stage 1 extractor (Prisma+Express) so existing repos can `alc adopt` incrementally. M18: $400-800K ARR, 8-10 enterprise logos, benchmark data decides whether `.al` or a native runtime is worth building.

## 6. Team and cost

- **Founder A (CEO/compiler):** IR, evaluator/lowering, checks, diagnostics, patch projection, MCP server. This is the product; it cannot be outsourced.
- **Founder B (runtime/codegen):** `defineAction`, emitters (Drizzle/Zod/Hono/pg-boss), contract test generation with fast-check + pglite, trace recorder, `explain_failure` rules, the `saas-starter`.
- **Person C (part-time or month 4+, benchmark/devrel):** harness, scoring, baseline audits, monthly runs, write-ups, design-partner onboarding.

**Outsource:** benchmark baseline implementations (contractors outside the team, required for credibility, ~$15-25K one-off); security review of `defineAction` and the policy evaluator before public release (~$10K); legal for license FAQ and ToS. **Skip:** Studio UI, hosting, fine-tuning, a native runtime, GraphQL/gRPC, non-Postgres.

**Burn:** 2 founders at below-market salary plus C part-time, tooling, model spend for the benchmark (the expensive line: ~100 tasks × 4 arms × 3 models × 5 runs ≈ 6,000 sessions at ~$3-10 each, $20-60K per full run; v0 at 30 tasks is ~$6-18K), infra ≈ **$30-45K/month**, ~$550-800K through M18. Bootstrap through M6 on design-partner services; raise $1-2M pre-seed only once the benchmark number exists.

## 7. Five biggest risks and how this strategy handles them

1. **No-training-data penalty eats the DSL gain.** Handled by making the surface TypeScript (prior transfers), a ≤15-construct regular library with one spelling each, a 1.5k-token always-on spec with progressive disclosure, and a compiler that acts as validator with one-iteration repair. Syntactic-error rate is a reported benchmark metric so we see it rather than guess.
2. **MDA round-trip rot (generated code nobody can edit, IR drifts from text).** Handled by text-as-source, deterministic one-directional derivation, span-local patch projection with a golden round-trip corpus, `@generated` headers with content-hash writes, `alc check --clean` as CI drift guard, exactly three typed escape hatches whose imports are scanned into the graph, and `alc eject` demoable at week 12 as the no-lock-in proof.
3. **The benchmark shows the graph (arm B) captures most of the gain, or <15 points overall.** This is designed as a finding, not a failure: the IR, MCP server, diagnostics, and governance tier all survive; we drop the language layer and sell the contracts/impact/audit layer over existing TS (Stage 1 extractor is already on the M12 roadmap). The 2x2 arms exist precisely so this decision is made by data in month 3, not by taste in month 18.
4. **Incumbents (Convex, Encore, Prisma Next) absorb "agent-safe backend."** They own runtimes and schema; none has contracts, effects, intent, impact, or a neutral cross-agent benchmark. We stay runtime-agnostic (Postgres, Hono, pg-boss → Temporal/Restate later), compile `entity` to their layers rather than compete, and own the measuring stick.
5. **Premise erosion: frontier models halve waste yearly, so "agents can't navigate" stops being true.** We do not sell navigation. We sell the costs that do not erode: input tokens dominate at 1000x chat, 30x variance, and "compiles but subtly wrong" failures. Contracts, auth-matrix tests, encoded pitfalls, and audit are correctness and governance, which get more valuable as agents write more of the code (Anthropic's >80%). Time-box: if post-Stage-2 gain is <30% over plain TS + LSP, pivot to the governance layer.

## 8. Why this beats the other obvious angles

- **"Stage 1 graph-first, language later" (the commercial brief's pick):** faster to revenue (6-9 months vs 9-12), but on existing code contracts, policies, and effects are mostly unrecoverable (Opaque nodes at ~50-70% confidence), so the benchmark can only show orientation gains, which free CodeGraph MCPs, Augment, and Claude Code's built-in LSP are already eroding. It cannot produce the pass-rate gain that distinguishes us; it produces a token-count press release. We keep the narrow extractor as the M12 adoption path instead.
- **"New `.al` syntax first" (the architecture brief):** cleanest IR and best human readability, but pays the full training-data tax and the full tooling tax (Wasp) before any evidence exists. We keep it as a projection to add once a corpus exists.
- **"Vertical app generator / Keel-style services":** real revenue, but it is an app company; it never produces the representation or the benchmark, and it competes with Lovable/Replit on distribution we do not have.
- **"Agent cost observability only":** 3-6 months to revenue but crowded (Langfuse, Helicone, Portal26) and low defensibility; we ship it as a feature of the paid tier, not as the company.

The honest cost of this angle: it is 3-6 months slower to first dollar than graph-first, and it bets month 3 on a public number we do not control. That is the point. A representation company that is afraid of its own benchmark should not exist; one that publishes it owns the category's measuring stick whether or not the language wins.

---

# Critiques

## Verdict: viable-with-changes

## Framing

The proposal is better than most "AI-native language" pitches because it has already conceded the two things that usually kill them: it does not ship novel syntax, and it names a kill criterion. But it then reconstructs most of the original risk under new names. Read as an investor, this is a plan to build a backend framework (Hono + Drizzle + pg-boss + Better Auth + a custom data-access API + a contract runtime) in 12 weeks with two people, publish a self-authored benchmark in month 3, and sell $60K governance contracts on a footprint that will be, at best, one greenfield service per customer. Each of those is a known failure shape. Below, in the order asked.

## 1. The adoption assumption

"Greenfield is where a representation wins; we do not promise migration of legacy code in year one." This single sentence disqualifies the stated ICP. Companies with 30-300 engineers on TypeScript monorepos do not have greenfield. They have a new service inside an existing monorepo that must follow the house conventions (NestJS + Prisma, or Express + Prisma, per the proposal's own baseline list). A tech lead who adopts Lattice is introducing a second HTTP framework (Hono), a second ORM (Drizzle), a second job system (pg-boss), a second auth library (Better Auth), a bespoke data-access API (`db.Invoice.update`, `db.Member.none`, `db.now()`, `self.total.equals` in the examples) and a runtime library in the production hot path, all from a two-person company whose longevity is a bus-factor risk. The comparables are not encouraging: Encore has the same shape, five years, roughly $4-7M raised, ~200 production teams. Hasura and Keel both had to find a second act. Wasp dropped its DSL and is still small. The proposal cites these and then assumes a faster curve with less money and a less mature stack.

The deeper problem: agents do not pick frameworks; humans do, and the human's criteria (ecosystem, hiring, escape velocity, "will this exist in three years") are exactly where a new framework is weakest. "The backend representation coding agents cannot get subtly wrong" is a line that persuades an AI-enablement lead; the person who has to say yes is the staff engineer who owns the monorepo, and the pitch has nothing for them that NestJS + Zod + Prisma Next + a good CLAUDE.md does not already offer.

## 2. "TS-embedded solves the no-training-data problem" — it moves it

The proposal claims "contracts are a decidable TS-subset expression language" and in the same breath writes contracts as arbitrary arrow functions: `requires: { amountMatches: ({ input, self }) => self.total.equals(input.amount) }`. Pick one. Either:

(a) the compiler parses the lambda body and accepts only a restricted AST (no calls except whitelisted, no closures, max path depth 3, etc.). Then every agent's TypeScript prior actively works against you: the model will write ordinary TS in that lambda (`await db.query(...)`, `input.items.some(...)`, a helper call) and get rejected. That is the no-training-data tax, relocated from syntax to semantics, which the agent-cost brief itself identified as the more expensive class. The "1.5k-token core spec" cannot specify which TS is legal inside a contract.

(b) the lambdas are opaque. Then "generate an arbitrary via fast-check that violates exactly that clause," "cause (the fact violated: expected type/contract/policy)," "evaluated LHS/RHS values" in `explain_failure`, and "ensures violated → highlight handler write sites that touch result.<field>" are all impossible. The contract-driven test generation collapses to "call the function, see if it throws."

The proposal never says which, and the entire differentiation (contracts as verified graph facts, not heuristics) depends on (a). The same ambiguity afflicts the data-access layer: if handlers use Drizzle directly, the IR cannot know field-level reads/writes ("handler import scan" gives file-level edges); if handlers use the bespoke `db.Entity.*` API, that is a new ORM with zero prior that every agent must learn from in-context docs.

Also unaddressed: stable identity in a TS-embedded form. The architecture brief stored ULIDs as trailing annotations in `.al`. In TS you have comments or a sidecar; renames of `export const InviteMember` break identity unless the reconciler guesses. "Stable ids like `Team.inviteMember`" are strings in a call, which agents will edit freely. And "the compiler evaluates the declaration module in a sandbox" loses source ranges entirely; you need the AST anyway, which means the "sandbox evaluator" is in practice an AST lowering of a restricted TS subset. That is a DSL with TS syntax, with all the irregularity of TS object literals (spreads, computed keys, `as const`, imports of helpers) that you must reject one by one.

## 3. Do 2027 frontier models make the problem disappear?

The proposal concedes navigation erodes and retreats to "costs that do not erode: input tokens dominate, 30x variance, compiles-but-wrong." Two of those three are model-vendor properties that the vendors are fixing on a quarterly cadence (prompt caching, 1M+ context, persistent repo memory in Claude Code/Codex/Antigravity, cheaper models). The `overview`, `conventions`, and `find` tools are precisely what persistent agent memory makes redundant by mid-2027.

"Compiles but subtly wrong" is the one durable cost, and the proposal's answer is contracts plus generated tests. But the agent-cost brief already said the quiet part: "a wrong `ensures` produces a passing wrong program." Against the real comparator (an agent writing Zod schemas plus Vitest tests in plain TS), the delta is: the agent writes a contract instead of a test. Same author, same blind spot, less expressive. The proposal does not explain why the pass-rate on *hidden* tests should rise by 15 points when the hidden tests encode intent that neither the contract nor the hand-written test captured. The pieces that plausibly do raise hidden pass rate are the encoded pitfalls (raw-body webhook, idempotency) and policy-coverage-as-error; those are a library and a lint rule, not a representation.

## 4. Would the benchmark be believed, and can it even be run?

Two internal contradictions make the M3 benchmark unrunnable as written:

- "The 2x2 arms (baseline / baseline + our graph MCP / ...) are non-negotiable" versus "Deferred: ... Stage 1 extractor for arbitrary TS repos (narrow Prisma+Express only, and only with a third person)." Arm B *is* the Stage 1 extractor. Without it there is no arm B, no attribution of graph vs language, and the proposal's own "if arm B captures most of the gain the language is not the product" decision cannot be made.
- The 12-week table it inherits (week 11: "25 tasks × {TypeScript baseline, AgentLang}") was written for a Langium `.al` architecture and for two arms. The proposal swaps the representation, adds three models, two harnesses, N=5, external baseline authors, and still claims "published with the first release."

Budget is off by an order of magnitude. "Three repo sizes: ~2k, ~15k, ~60k LOC" in five stacks that must be behaviorally equivalent against the same HTTP suite is roughly 350-400k LOC of audited application code. "$15-25K one-off" buys one small seed app in two stacks. Sessions: 30 tasks × 4 arms × 3 models × 2 harnesses × 5 runs is 3,600 sessions, not the ~600 the "$6-18K" line implies, and on a 60k LOC repo per-session cost is $10-30, not $3-10.

Credibility: the task categories are public ("add auth, pagination, caching, webhook, RBAC") and the primitive list is `authorize, paginate, cache, webhook, idempotent`. "A held-out task set authored after primitives are frozen" does not help when the categories are the primitives. Every reader will say what they said about Encore's benchmark: of course the framework with a webhook primitive wins "add a webhook." The comparison that would matter is Lattice vs Encore.ts vs Convex (framework vs framework), and against those the proposal has no argument for a 15-point gap. "Pre-registered analysis" has no registrar; "accept external submissions" has no audience at M3. Reproducibility with Claude Code as a harness is weak: closed system prompt, silent version drift. The only path to belief is a third party running it (an academic group or a neutral foundation), and nothing in the plan secures that.

## 5. Are the paid features things enterprises buy?

- "Audit log of every agent patch" presumes agents edit through `apply_patch`. Claude Code, Cursor, and Codex edit files directly; the proposal itself ships `edit_source` and "read/edit passthroughs." The audit trail of direct edits is `git log`. What remains is a CI check, which is a lint rule, which is free-tier by the proposal's own "IC features free" rule.
- "Policy-as-code gates ('no agent patch may remove a policy')" are a pre-commit/CI assertion over the IR diff; a customer replicates it with CODEOWNERS plus one test. It only protects Lattice-declared code, which in year one is one service.
- "Token/cost-per-task dashboards" from an MCP server are not technically possible. An MCP server does not see the host agent's token usage. You get that data only by being the harness or the API proxy, which is Helicone/Portal26/the model vendor's territory, which the proposal correctly says is crowded. This is the first paid feature and it cannot be built as described.
- "$60K/year ... from companies with 30-300 engineers." GitLab's buyer-based open core works because the whole org lives in GitLab. Here, paid value scales with Lattice footprint, and the footprint is one greenfield service. No VP Eng expenses $60K to govern one service built on a 12-month-old framework.
- "Bootstrap through M6 on design-partner services" contradicts "free Enterprise for six months" to those same design partners. There is no services revenue in this plan.
- "$400-800K ARR at M18 with 8-10 enterprise logos" implies ~$60K ACVs closed inside ~9 months of first paid feature, against 6-9 month enterprise procurement cycles, for a framework in production. Encore is the base rate.

## 6. Can 1-3 people build it?

Founder A's list: "IR, evaluator/lowering, checks, diagnostics, patch projection, MCP server." Founder B's: "defineAction, emitters (Drizzle/Zod/Hono/pg-boss), contract test generation with fast-check + pglite, trace recorder, explain_failure rules, the saas-starter." Twelve weeks. Then the benchmark harness, the external baseline audits, a security review, a VS Code extension, docs, and a public launch. Encore reached a comparable surface with ~10 people over years. Specific items that are each a multi-month project on their own: span-local projection of IR patch ops back into TS object literals with comment and formatting preservation (ts-morph makes this merely painful, not easy); cascade-collapsed diagnostics over tsc output (tsc provides no causal links; collapsing 40 errors to one root cause is an inference problem); a contract-expression parser plus fast-check arbitrary generator that produces "an input that violates exactly that clause" for anything beyond trivial comparisons; a trace recorder with correlation across pg-boss jobs; idempotency with correct concurrency semantics inside the transaction pipeline.

## 7. Abstraction leakage and escape hatches

"Exactly three escape hatches" is asserted; the worked example already violates it (`run:` is an inline handler, not `handler ts "./path.ts"`). More important, the examples show the easy 20% of a Stripe webhook: who maps Stripe's `invoice.paid` payload to `{stripeEventId, invoiceId, amount}`, resolves the Stripe invoice id to your invoice, handles `customer.subscription.updated`, retries on a missing customer, and reconciles amounts in different currencies? All of that lands in handlers using either the bespoke data API (no prior) or Drizzle (graph blind). Real SaaS backends are joins, aggregations, reports, bulk operations, batched background jobs, file uploads, search, soft deletes, sagas. The "40% handler lines" tripwire will trip on the first real customer, at which point Lattice is Hono + Drizzle with a mandatory ceremony layer and a runtime dependency, which is the MDA endgame the proposal says it has learned from. `alc eject` as the no-lock-in guarantee also sets the bar that generated code must be human-grade on day one, or the eject demo is a liability rather than a proof. And "runtime-agnostic" is marketing when `@lattice/runtime` evaluates `requires` in production on every request and is the thing getting the security review.

## 8. Smaller hand-waves worth naming

"Lattice" is a $3B HR-software company's trademark and also a semiconductor company; pick another name before any public artifact. "intent: required" will produce "Marks invoice paid." boilerplate; the readability test checks the printer, not the content. "Trust rule: regenerated on every build" is undermined by agents that edit files between builds (the staleness window is exactly the agent's working window; you need a watcher and a freshness stamp on every answer). "Never a stack trace" is wrong for handler exceptions. "Compile workflow/retry/queue to Temporal/Restate later" is listed in both risks and skips; pg-boss semantics (at-least-once, no durable timers across restarts in the way Temporal provides) will leak into `step.waitFor("InvitationAccepted", { timeout: "7d" })`.

## What the proposal gets right (keep these)

The TS-embedded decision over `.al`. Text as source of truth with derived IR, content-hash regeneration, and a CI drift guard. Policy coverage as a hard compile error with generated auth-matrix tests. Encoded third-party pitfalls as primitives. Structured diagnostics with root cause and patch ops, and error-signature-to-repair-strategy tables. `impact` returning migration-needed / API-breaking as verified facts. The 2x2 attribution design and the refusal to accept a token-only win. Apache-2.0, DCO, never relicense, explicit generated-code ownership. Explicit kill criteria. `intent` as a recorded decision, not an inferred one.

## What would make it fundable

Invert the sequencing without abandoning the thesis. Build the contracts/policy/impact layer as an attachment to the frameworks the ICP already uses (start with one: NestJS + Prisma or Hono + Drizzle, chosen by where design partners are), with the narrow extractor first because the benchmark and the fallback both need it. Ship policy-coverage-as-error, auth-matrix test generation, webhook/idempotency primitives, and structured diagnostics as things a team adds to an existing service in an afternoon. Keep the compile-to-everything pipeline as the opt-in "new service" mode, not the entry point. Replace the token dashboard with something the MCP server can actually observe (contract and policy coverage over time, impact reports on PRs, agent-change diff classification), and sell on-prem/SSO/multi-repo registry. Budget the benchmark at one seed app, two sizes, three stacks, and hand the harness to a neutral third party before publishing a number. With those changes the company has a product in month 4 that works on real code, generates the logs that decide which primitives deserve to exist, and keeps the language as an earned option rather than a bet.

### Fatal flaws
- The benchmark design is internally inconsistent and cannot run at M3: the '2x2 arms ... are non-negotiable' but arm B (baseline + graph MCP over plain TS) requires the Stage 1 extractor, which the same proposal lists under 'Deferred'. Without arm B the central decision ('if arm B captures most of the gain, the language is not the product') cannot be made.
- The contract layer is specified two incompatible ways: 'contracts are a decidable TS-subset expression language' versus contracts written as arbitrary arrow functions in every example. If lambdas are parsed/restricted, the training-data tax is relocated into semantics (agents will write ordinary TS and be rejected); if lambdas are opaque, 'violates exactly that clause' test generation, 'cause: the fact violated', evaluated LHS/RHS in explain_failure, and write-site highlighting are all impossible. The differentiation ('verified graph facts, not heuristics') depends on the version that is not buildable as described.
- The first paid feature, 'token/cost-per-task dashboards', cannot be built from an MCP server: the server never sees the host agent's token usage. That data exists only at the harness or API-proxy layer (Helicone/Portal26/model vendors), which the proposal itself calls crowded and low-defensibility.
- The paid tier's value scales with Lattice's footprint inside a customer, and the stated ICP ('greenfield ... we do not promise migration of legacy code in year one') caps that footprint at one new service. Audit logs and policy gates only cover Lattice-declared code and only capture edits routed through apply_patch; agents editing files directly (the normal Claude Code/Cursor path, and the proposal ships edit_source) leave git log as the audit trail. No VP Eng pays $60K/year for that.
- Benchmark budget and schedule are off by roughly an order of magnitude: 'three repo sizes: ~2k, ~15k, ~60k LOC' in five behaviorally-equivalent stacks is ~350-400k LOC of externally audited code against a '$15-25K one-off' line, and 30 tasks x 4 arms x 3 models x 2 harnesses x 5 runs is 3,600 sessions, not the ~600 implied by '$6-18K'. The 12-week table was written for a different (Langium .al, two-arm) architecture and is reused unchanged.
- Team capacity: two founders in 12 weeks are assigned an IR, a restricted-TS evaluator/lowerer with stable identity, domain checks, cascade-collapsed diagnostics, span-local IR-to-TS patch projection with comment preservation, an MCP server, a runtime, five emitters, fast-check contract test generation, a trace recorder, explain_failure, the seed app, the benchmark harness, and a public launch. Encore reached a comparable surface with ~10 people over years. Several items (patch projection, cascade collapse over tsc, exact-clause arbitrary generation) are each multi-month on their own.
- Bootstrap plan is contradictory: 'bootstrap through M6 on design-partner services' while offering those same design partners 'free Enterprise for six months'. There is no revenue source before the seed round the plan says it will not raise until a benchmark number exists.

### Weak assumptions
- That a TS-embedded surface inherits the model's prior cheaply. The prior transfers to syntax only; the bespoke data-access API (db.Invoice.update, db.Member.none, db.now(), self.total.equals), policy.system(Stripe), idempotent: {key}, events.emittedExactly, and step.waitFor semantics have zero prior and must be learned from a 1.5k-token spec that cannot cover them.
- That a 15-point hidden-test pass@1 gain is achievable versus plain TS. The one failure class that does not erode ('compiles but subtly wrong') is addressed by contracts the same agent writes, with the same blind spots as the tests it would otherwise write; the proposal itself notes 'a wrong ensures produces a passing wrong program'. The components that plausibly move hidden pass rate (encoded webhook/idempotency pitfalls, policy-coverage-as-error) are a library and a lint rule, not a representation.
- That the benchmark will be believed. Task categories ('add auth, pagination, caching, webhook, RBAC') map one-to-one onto the primitive list, so a 'held-out task set' does not neutralize the obvious objection; there is no registrar for 'pre-registered analysis', no third party committed to running it, and Claude Code as a harness drifts silently. The relevant comparison is framework-vs-framework (Encore.ts, Convex), where no argument for a gap is offered.
- That orientation-era tools (overview, find, conventions) retain value into 2027 when Claude Code, Codex, and Antigravity ship persistent repo memory and built-in LSP; the proposal says it does not sell navigation but a third of the tool surface is navigation.
- That 'exactly three escape hatches' holds. The worked examples already use an inline run: handler, and real SaaS work (payload mapping, joins, aggregations, reports, bulk ops, batching, uploads, sagas) lands in handlers, pushing 'handler lines / total lines' past the 40% tripwire on the first real customer and reproducing the MDA endgame.
- That stable node identity survives in a TS-embedded form. ULIDs have nowhere to live except comments or a sidecar; agents freely edit the 'Team.inviteMember' string ids; the sandbox evaluator discards source ranges, so an AST lowering of a restricted TS subset is required anyway, which is a DSL with TS syntax and all of TS's irregularity to reject.
- That 'runtime-agnostic / no lock-in' is true while @lattice/runtime evaluates requires in production on every request and alc eject produces code that depends on it; and that ejected generated code will be human-grade on day one, which the eject demo requires.
- That $400-800K ARR by M18 from 8-10 enterprise logos at ~$60K ACV is reachable inside ~9 months of first paid feature against 6-9 month procurement cycles for a production framework from a two-person company; Encore's five-year trajectory is the base rate.
- That 'Lattice' is a usable name; it is a $3B HR-software company's trademark and a semiconductor company.

### Keep
- TS-embedded declarative layer instead of a bespoke .al grammar; .al only as a later projection if a corpus exists.
- Text as the only source of truth, IR derived deterministically, @generated headers with content-hash writes, 'alc check --clean' drift guard in CI, and a demoable eject path.
- Policy coverage as a hard compile error plus generated auth-matrix tests (every exposed action x policy x actor fixture); this is concrete, demonstrable, and valuable even as a standalone add-on to existing frameworks.
- Encoded third-party pitfalls as primitives (raw-body webhook signature verification, idempotency keys, cursor pagination); this is where real integration failures and hidden-test losses come from.
- Structured, cascade-collapsed diagnostics carrying cause[], related[], and fixes[] as patch ops with confidence, with deterministic error-signature-to-repair-strategy mapping.
- impact(ref | patch) returning migration-needed and API-breaking as verified facts, and explain_failure returning actual-vs-expected, the causal chain, and the structural diff since last green instead of a stack trace.
- The 2x2 attribution design, the insistence that a token-only win is insufficient, publishing losses, and reporting syntactic-error rate separately.
- Explicit kill criteria tied to the benchmark and a pre-committed pivot to the contracts/impact/governance layer over existing TS.
- Apache-2.0 for everything developers type into, DCO not CLA, never relicense, explicit generated-code-ownership FAQ, closed control plane only.
- intent as a required, recorded field (a decision log), so agents stop re-asking the same ambiguity questions; and ids-not-bodies, hard token caps, and source handles on every MCP answer.

## Verdict: viable-with-changes

Evaluated as the agent that would be driving this through MCP on real tasks.

**Would it make me faster, cheaper, more reliable than TS + good MCP tools?** Partly, and for different reasons than the proposal emphasizes. On a successful run of a medium task against the saas-starter, I estimate 30-45% fewer input tokens, almost entirely from locality (one declaration instead of five layers) and derived layers (no schema/zod/DTO/route drift), not from the graph tools. On a 2k LOC app I would honestly rather read the three relevant declaration files than make eight `inspect` calls; the graph tools pay off at 15k+ LOC and the v0 benchmark does not have a Lattice repo that size. Reliability gains are real but narrow: missing auth, webhook raw body, idempotency, migration generation. Business logic, read-heavy queries, third-party semantics beyond the three encoded pitfalls, ambiguity with the human, and data migration on real data cost exactly what they cost today.

**Where I would still burn tokens.** (1) Learning the facade APIs. The examples use `db.Member.none`, `db.Invitation.upsert`, `actor.membership(...)`, `Role.exclude`, `Stripe.EventId`, `policy.system`, `step.waitFor`, `events.emittedExactly`. None of these exist in my prior; my Prisma/Drizzle priors actively push me toward `db.member.findFirst` or `db.select().from(members)`. Expect 5-10 `docs()` calls per task and 1-2 extra compile iterations in year one, which eats most of the token win until a public corpus exists. (2) The hidden second type system: the 'restricted TS subset' is invisible to tsc and the LSP. I will naturally write `const ROLES = [...] as const`, a shared `ownerOrAdmin` helper, or a loop to declare similar actions, and only the Lattice compiler will reject it, after tsc passed. That is precisely the 'compiles then fails' cycle the proposal claims to remove. (3) Reading generated code and runtime source to learn semantics the spec leaves implicit: does `ensures` run before or after commit, can it read the DB, is `retry` idempotency-aware, what does `ctx.call` inside a transaction do. If the 300-token semantics cards do not answer these precisely I will open `@lattice/runtime`. (4) Writing `intent:` prose for every action because the compiler demands it.

**Would I hallucinate the syntax?** Not the TypeScript syntax. I would hallucinate the library surface, which is the same failure in a different place. The proposal's claim that TS-embedded 'inherits billions of tokens of prior' is true for braces and arrows and false for everything that matters. The honest mitigation is to minimize invented surface: let handlers use Drizzle directly (prior transfers, and reads/writes can be inferred statically from table references far more reliably than from an entity facade), publish the entire declarative API as a single `.d.ts` reachable by one `docs('api')` call, and ship an ESLint rule plus branded types that make the restricted subset visible in the editor before the compiler runs.

**The contract contradiction is the thing I would most want fixed before any code is written.** The decidable expression language (needed for IR serialization, test generation, auth-matrix derivation, and explain_failure's actual-vs-expected) and the async DB-backed lambdas in every example cannot coexist. The realistic split: `requires`/`ensures` as pure expressions over input/self/result/actor (decidable, test-generated, diffable), plus a small set of declarative DB predicates (`unique(Member, {teamId, email})`, `exists(Team, id)`, `none(...)`) that are IR-expressible and compile to both SQL and fixture generators, plus a named, traced, non-generated `guards` tier for anything else. Without that, the first realistic precondition I write either gets rejected or silently disables the whole test-generation story.

**Diagnostics and debugger: useful or noise?** Useful, with specific corrections. Cascade collapse is the highest-value item and the least designed; collapsing Lattice's own domain errors is easy, collapsing the 30 tsc errors from one bad field name in a handler is the hard part and it is not in the plan. The fix list is useful when fixes are IR patch ops I can apply in one call and the label carries evidence ('used by 3 sibling actions'); the confidence float is fabricated and I will ignore it. `explain_failure` with actual-vs-expected, fixture, causal chain, and since-last-green is exactly right, but 'never a stack trace' is wrong: when a handler throws, the stack line is the fastest fix, so make it retrievable at detail:full. `check(scope=affected)` is the tool I would call most. `conventions(topic)` is moot in the DSL arm and heuristic in the plain-TS arm; low value. `impact` is only as good as handler effect analysis, which import scanning cannot deliver at the precision needed; if it is 70% accurate I will stop trusting it and the graph loses its reason to exist.

**Expressiveness cliffs I would hit in the first week:** DB-dependent preconditions; actions that are not bound to a single entity (checkout touching Order, Payment, Inventory); read-only endpoints with joins and aggregations (a `query` construct is missing, so reports become untracked handlers); policies needing membership lookups; PATCH semantics and optimistic concurrency; file upload and streaming; cron schedules; multi-tenancy, which is deferred to V1 even though the demo app and the ICP are multi-tenant; and any customization of generated output (error envelope, pagination defaults, status codes). Zero passthrough in V0 is a principled choice that will be reversed by the second design partner.

**Benchmark.** The 2x2 arms, pre-registration, held-out tasks, and publishing losses are the strongest part of the proposal and should be kept exactly. But the v0 instance cannot support the gate it is attached to: small seed app, no outsider-authored large Lattice repos, N=5 at 30 tasks, three models, non-overlapping CIs on 15pp. I would change the gate to a pooled, pre-registered effect size with per-category reporting (the gains will be concentrated in auth/webhook/idempotency/migration tasks and near zero elsewhere), move the go/no-go to M9-M12 when a 15k LOC Lattice repo exists, include one 15k LOC repo in v0, and add a fifth arm: plain TS plus the same pitfall primitives shipped as an ordinary library with no compiler, to separate 'good library' from 'representation'.

**Concrete changes I would want:** resolve contracts into pure expressions + declarative DB predicates + traced guards; drop the entity facade in handlers in favor of Drizzle with static effect inference; add a `query` construct with declared reads; make `tenant` V0; add two or three documented generated-output overrides; make the restricted TS subset visible via types and lint before the compiler; default `inspect` to returning the source span for DSL nodes and ids only for edges; keep stack traces retrievable; make the trace table opt-in and schema-isolated; drop fake confidence floats; make `intent` required only on exposed actions and allow it to be inherited from the entity; and fix the benchmark gate as above.

**Net:** the agent-facing core (policy coverage as an error, encoded pitfalls, locality, derived layers, structured affected-scope check, collapsed diagnostics, impact, explain_failure, drift guard, eject) is what I would want and it is the part that survives any outcome of the language bet. The contract layer and the benchmark design are not buildable as written, and the TS-embedded choice is being credited with eliminating a tax it only relocates. Fix those three and this is a product I would be measurably better with on the task classes it targets, and honestly no better on the rest.

### Fatal flaws
- Contract layer is self-contradictory. The architecture requires contracts to be a decidable, no-recursion expression language (serialized into the IR as {op, lhs, rhs}, translated to fast-check properties, evaluated for actual-vs-expected in explain_failure), yet every worked example writes contracts as arbitrary async TS lambdas with DB access (`db.Member.none(...)`, `actor.membership(teamId).role.in(...)`, `events.emittedExactly(...)`). You cannot have both. If contracts are restricted, I hit an expressiveness cliff on the very first realistic precondition (uniqueness, existence of a related row, membership) and the compiler rejects code that tsc accepted. If contracts are arbitrary lambdas, then contract test generation, auth-matrix derivation, IR-level diff of contracts, and explain_failure's LHS/RHS values all become impossible. This has to be resolved before week 1 or the whole 'contracts + generated tests' pillar is vapor.
- The v0 benchmark is structurally unable to produce the claim the strategy is gated on. (a) The seed app is a ~2k LOC saas-starter; the agent-cost brief itself says orientation gains on small repos are 10-20%, so the graph arms will show little. (b) Nobody outside the team can write a 15k or 60k LOC Lattice baseline because nobody outside the team knows Lattice, so either the large-repo arms don't exist or the 'baselines audited by outsiders' credibility claim is false for exactly the arm that matters. (c) 30 tasks x N=5 gives roughly +/-8pp CIs per cell; demanding non-overlapping CIs on a 15pp pass@1 gain across three models at M3 means the real effect must be 20pp+, which is implausible. The kill/pivot trigger is therefore set on an underpowered measurement and will fire (or be fudged) for statistical reasons, not product reasons.
- TS-embedded does not eliminate the training-data tax; it converts it into a wrong-prior tax plus a hidden second type system. Everything I would actually type lives in invented facade APIs (`db.Invitation.upsert`, `Role.exclude`, `Stripe.EventId`, `policy.system`, `step.waitFor`, `events.emittedExactly`, `actor.membership`) where my Prisma/Drizzle/Zod priors actively mislead me, and in a 'restricted TS subset' (no helpers, no loops, no computed literals, no import cycles) that tsc and the LSP cannot see. I will write code that type-checks and then get rejected by the Lattice compiler with 'dynamic computation not allowed'. The 1.5k-token core spec cannot cover the facade surface. This is the same class of cost as novel syntax, just displaced, and the proposal's risk #1 mitigation treats it as solved.
- V0 scope contradicts its own ICP and demo. The first ten customers are 'B2B multi-tenant SaaS', the demo/benchmark app is orgs+members+invites, yet `tenant` scoping is deferred to V1 and V0 has zero passthrough for customizing generated output (error envelope, pagination defaults, status codes, route shapes). The only escape hatches are handler/integration/middleware. Any real customer with an existing API contract, a non-CRUD read endpoint (reports, aggregations, joins), or tenant isolation needs hits the wall in week one and either forks the generated code (killing the drift guard) or leaves.

### Weak assumptions
- Cascade collapse of tsc errors is hand-waved. The Lattice compiler can collapse its own domain diagnostics, but a wrong field name in a handler produces 15-40 tsc errors across handler + generated types, and attributing those to one root symbol requires real work with ts-morph that is not in the 12-week plan.
- `impact` and `effects` edges for handler code are derived from import scanning, which yields entity-level, ~70% accurate reads/writes. I will either over-trust it (confident wrong edits) or learn to distrust it and fall back to grep, at which point the graph has negative value by the proposal's own 'stale oracle is worse than grep' rule.
- Required `intent:` on every entity and action will produce boilerplate ('Creates a widget.') written by me, in output tokens that cost 5x, and gives PMs nothing. Intent is valuable only when a human writes it; making it a compiler error makes it noise.
- ids-not-bodies with depth=0 defaults means 5-8 round trips to understand one action's neighborhood. In the TS-embedded form the source file already IS the compact projection (~400 tokens per action), so `inspect` is largely redundant with `read_source`; the tools that earn their tool-call overhead are find, impact, check(affected), explain_failure and the diagnostics.
- 'Agents handle library-shaped DSLs well' is true for Zod/Drizzle because of millions of public examples; Convex and Encore ship extensive docs and MCP servers and still see hallucinated APIs. A zero-corpus library gets the same first-try error rate as a zero-corpus syntax until there are public examples.
- Fabricated `confidence: 0.8` floats on fixes are noise; I will read the label and the evidence ('used by 3 sibling actions'), not the number.
- 'Never a stack trace' in explain_failure is wrong. When a handler throws a TypeError the stack line is the fastest fix. The raw trace must be retrievable at detail:full.
- Sandbox evaluation of declaration modules is underestimated: cross-file entity references (`Invoice.id`, `Team.id`) create import cycles, evaluation order problems, and non-determinism that will produce confusing failures unrelated to the user's code.
- Auth-matrix test generation 'from the policy expressions' is only possible if policies are in the restricted expression language with known actor fixtures; a policy that calls a DB-backed `actor.membership()` needs a generated fixture model (teams, memberships, roles) that is not designed anywhere.
- ~200 generated fast-check property tests against pglite in under 60s is optimistic; and 200 generated tests on a 2k LOC app means `check` output must be aggressively filtered or every run is a wall of noise.
- Benchmark cost: $3-10 per session is low for Claude Code on a 15k+ LOC repo task ($5-20 is typical), so the model-spend line is understated by ~2x.
- Storing the trace recorder's `traces` table inside the customer's application Postgres is an enterprise objection (DBA/security review); it needs to be opt-in and in a separate schema or sidecar.
- The 2x2 arms conflate 'encoded-pitfall primitives' with 'representation'. A plain-TS arm that ships the same primitives as an ordinary library (webhook verify, idempotency, cursor pagination) without the compiler would reveal how much of the gain is just a good library.

### Keep
- Policy coverage as a hard compile error plus a generated auth-matrix test over HTTP. This is the single largest reliability gain I would actually get: 'forgot auth on an endpoint' is a top-three agent error and this makes it impossible.
- Encoded-pitfall primitives: webhook raw body + signature verification, idempotency key with generated dedupe table and duplicate-delivery test, cursor pagination. These are where my third-party integration failures come from and they are one-time knowledge that a representation can hold.
- Locality: intent/policy/requires/ensures/effects/run colocated in one 30-line declaration. This, not the graph, is the real input-token saver; it removes the schema/validator/DTO/route/serializer layer walk entirely.
- Derived layers (schema -> types -> validation -> routes -> OpenAPI -> migration) so layer mismatches cannot exist, with deterministic regeneration, content-hash writes, `@generated` headers, `check --clean` drift guard, `edit_source` refusing generated files, and `eject` as the no-lock-in proof.
- Cascade-collapsed domain diagnostics with a ranked, one-call-applyable fix list (keep the ordering and the evidence string, drop the fake probability).
- `check(scope=affected)` returning structured results for only the affected generated and hand-written tests.
- `impact(ref | patch)` returning affected nodes with why, tests to run, migration y/n, API-breaking y/n; and `explain_failure` returning actual-vs-expected, the triggering fixture, the causal chain, and the structural diff since last green.
- Text as source of truth, IR derived and cached in SQLite, no graph DB, span-local patch projection with a golden round-trip corpus.
- Hard server-side token caps with cursors on every tool response, and `docs(construct)` progressive disclosure instead of a 10k-token spec in context.
- The 2x2 benchmark design, pre-registration, held-out tasks authored after primitives freeze, charging spec tokens to the DSL arm, and publishing losses. Even if the language dies this asset survives.
- Buyer-based open core (Apache-2.0 compiler/runtime/MCP/CLI, paid governance: audit trail of agent patches, policy-as-code gates, multi-repo registry), DCO not CLA, explicit generated-code ownership FAQ.

