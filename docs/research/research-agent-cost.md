# Agent Task Cost: An Honest Decomposition and What Would Actually Reduce It

Perspective: a frontier coding agent (Claude Code-class) operating via MCP/CLI on a real repo, plus an agent-systems researcher. Numbers are estimates from my own operating experience; treat ranges as priors to be measured by the benchmark in section 6.

## 1. Where the cost actually goes today

Three reference tasks on a medium Express+Prisma repo (10-20k LOC, 80-200 files). A "medium" task in Claude Code typically consumes 40-120k input tokens (much of it cached re-reads), 3-8k output tokens, 25-70 tool calls, and 1-4 build/test iterations.

| Phase | RBAC feature | Validation bug fix | Stripe webhook |
|---|---|---|---|
| Orientation / context reconstruction | 25-35% tokens, 30-40% tool calls | 40-55% tokens, 50% calls | 15-25% |
| Locating the change site | 10-15% | 15-25% | 5-10% |
| Learning conventions | 10-15% (often discovered late) | 5-10% | 10-15% |
| Generating code | 10-15% tokens (but output tokens = 5x price) | 3-5% | 10-15% |
| Build/test/fix loop | 20-30% tokens, 25-40% calls | 15-25% | 25-40% |
| Verification | 5-10% (honestly, often shallow) | 5-10% | 10-15% (can't call Stripe) |

Why these shapes:

- **Orientation dominates because I have no persistent model of the repo.** Every session I re-derive: where routes are registered, how auth middleware is shaped, what the Prisma schema looks like, how errors are thrown, how tests are wired. On an unfamiliar repo I spend 8-20 tool calls before writing a line, and roughly a third of the files I read turn out irrelevant. Prompt caching makes re-reads cheap in dollars but not in attention: a 100k-token context full of half-relevant files measurably degrades my reasoning on the actual change.
- **Bug fixes are almost entirely location + understanding.** The diff is 3 lines; the cost is finding which of four validation layers (zod, Prisma, a custom middleware, a DTO class) actually produced the error.
- **The fix loop is expensive because the error signal is noisy.** A single wrong assumption about the schema produces 15-40 cascading tsc errors; I read 3-8k tokens of output to find the one root cause. Test failures give me stack traces, not "expected X, got Y because policy Z returned false."
- **Failed iterations cluster in predictable places:** layer mismatches (schema vs type vs validator vs serializer), third-party pitfalls (Stripe signature verification failing because `express.json()` consumed the raw body), fixture/env setup, and misremembered library versions (Prisma 5 vs 6 client API).
- **Conventions are learned late.** I discover "this repo uses Result types, not throws" after writing code the other way, usually from a lint error or a human reviewer.

Across the three tasks, roughly 55-70% of total cost is *reconstructing knowledge the codebase already contains*, 15-30% is *recovering from mismatches a compiler could have prevented*, and only 10-20% is the irreducible work of understanding intent and writing logic.

## 2. What each mechanism actually buys

| Cost bucket | Semantic graph | Declarative DSL | Derived code | Structured diagnostics | Contracts + test-gen | Capability primitives |
|---|---|---|---|---|---|---|
| Orientation | **-40 to -60%** on medium/large repos; ~0 on small repos (<30 files, I just read everything) | -10 to -20% (less to read) | - | - | - | - |
| Locating change site | **-50 to -70%** (stable ids, "who handles X") | -20% (one place per concept) | - | - | - | - |
| Conventions | -20% (queryable) | **-50 to -70%** (one way to do each thing, compiler-enforced) | -30% | -20% (autofix) | - | -30% |
| Generation | - | -30 to -50% output tokens | **-30 to -50%** (no boilerplate layers) | - | +10% (writing contracts is new work) | -20% |
| Fix loop | -10% | -20% | **-30 to -50%** (layer mismatches vanish) | **-30 to -40%** (root-cause collapse) | -10% | -30% on integration tasks |
| Verification | - | - | - | -20% | **+100% coverage**, shifts cost to compile time | - |

Realistic aggregate: **30-45% reduction in total agent task cost on medium repos**, with the largest and most certain share coming from the graph plus diagnostics (Stage 1, no new language), and a smaller, riskier share from the DSL. On small repos the gain shrinks to 10-20%. On large repos (100k+ LOC) the graph alone could exceed 50%.

**Costs that do not go away, and some that get added:**

- Understanding business intent and resolving ambiguity: "Can an admin invite an owner? Does re-inviting a pending email resend or error?" This is 10-20% of cost now and becomes a *larger* share after everything else shrinks. No representation fixes it; only a place to record decisions (an `intent` field in the IR) reduces re-asking.
- Choosing the abstraction (roles vs permissions vs ABAC) remains a judgment call.
- Third-party semantics (Stripe idempotency, event ordering, retries) stay. Primitives help only where someone encoded the pitfall.
- Data migration on real data, backfills, and rollout concerns are untouched.
- **New cost: the "how do I say this in your DSL" tax** (section 3). Can eat the entire DSL gain in year one.
- **New cost: trust.** A stale or wrong graph is worse than grep because I will act on it confidently. The graph must be regenerated by the compiler on every change and must offer a verifiable fallback ("show me the source").
- Human review remains the gate; auto-tests from contracts verify the contract, not the intent (a wrong `ensures` produces a passing wrong program).

## 3. The no-training-data problem

My priors on TypeScript come from billions of tokens. A new syntax gets zero. From direct experience writing in small DSLs from an in-context spec: with a 2-4k token spec of a *small, regular* language I achieve 70-85% first-try syntactic correctness; errors cluster at the edges (optional syntax, escaping, less common constructs). Correctness degrades roughly with *surface area times irregularity*, not linearly with feature count: 15 orthogonal constructs with one form each costs little; 15 constructs with three alternate spellings each costs a lot.

The deeper penalty is **semantic**, not syntactic: I do not know what `cache` does on invalidation, what `transaction` boundary covers, whether `requires` runs before or after policy, whether `retry` is idempotency-aware. Semantic unfamiliarity produces programs that compile and are wrong, which is the most expensive failure class. The spec must define semantics, not just grammar.

Mitigations, evaluated:

- **(a) Tiny, regular DSL.** Necessary, not sufficient. Target: 10-15 top-level constructs, one spelling each, no sugar, expressions in a TS subset.
- **(b) TypeScript-embedded typed DSL.** Strongest single lever. My TS prior transfers; the LSP tells me the valid keys; tsc gives errors I already understand; no new editor tooling needed. Convex, Encore.ts, Drizzle, and Zod are existence proofs that agents handle library-shaped DSLs well. Cost: the compiler must extract IR from a restricted TS subset (evaluate the module, reject anything dynamic), and readability for a PM is slightly worse than a bespoke syntax.
- **(c) Spec in context.** A 2-4k token core spec is 3-8% of a typical task and is cheap under prompt caching. Beyond ~10k tokens it crowds out the task. Use progressive disclosure: 1.5k always-on core plus a `docs(construct)` tool for on-demand detail.
- **(d) MCP tool schemas.** 10-15 tools at 200-500 tokens each = 3-6k tokens per session. They teach *operations* on the project, not the language. Right for Stage 1; they do not substitute for (b) or (c).
- **(e) Fine-tuning / provider partnerships.** Not realistic for a small team on frontier models. Possible later for OSS models via a synthetic corpus, but customers run Claude/GPT. Revisit only after traction.
- **(f) Grammar-constrained decoding.** Unavailable through Claude Code/Codex/Cursor. The functional substitute is compiler-as-validator with a tight repair loop: a structured parse error with a suggested patch costs me one iteration, not five.

**Recommendation:** (b) + (a) as the surface, (c) progressive spec, (d) for project operations. Treat the JSON IR as the real product and the TS-embedded form as the primary projection. Keep a bespoke `.al` syntax as a possible *later* projection once the IR is proven and there is a corpus to teach it from.

## 4. The agent-facing interface I actually want

Assume the client is Claude Code / Codex / Cursor via MCP, and also offer a CLI with `--json` (I compose CLIs with pipes; MCP schemas add fixed context overhead). Every response has a hard token cap and a cursor.

**Tools (inputs → outputs, budget):**

- `overview()` → stack, entry points, top modules, test/build commands, 5-line conventions summary, counts. ≤1.5k tokens. Called once per session.
- `find(query, kind?, limit=20)` → semantic + lexical search over entities/actions/routes/functions/tests. One line per hit: `id | kind | path:line | summary`. ≤800 tokens.
- `inspect(id, depth=0, include_source=false)` → signature, contract, policy, effects, callers/callees (ids only), tests, owner, last change summary. ≤1.5k tokens; source on request only.
- `impact(id | proposed_change)` → affected nodes with *why*, tests to run, migration needed (y/n), API breaking (y/n). ≤1k.
- `conventions(topic)` → "how this repo does errors / pagination / auth" with one canonical example. ≤800.
- `apply(semantic_op | patch)` → applies and returns structured diagnostics.
- `check(scope=affected)` → typecheck + lint + affected tests only. Structured.
- `explain_failure(test_id | diag_id)` → see below.
- `trace(action, input)` → execution trace with policy/contract evaluations and DB calls.
- `docs(construct)` → 300-token semantics card for a DSL construct.

**A structured diagnostic** (≤300 tokens each, cascades collapsed to one root cause):
`{code, severity, message (one line), node_id, path:line, cause (the fact violated: expected type/contract/policy), related (≤5 ids), fix: {op|patch, confidence}, since_last_green: diff summary, docs: construct}`. The single highest-value feature here is **cascade collapse**: 40 tsc errors from one wrong field name should arrive as one diagnostic.

**`explain_failure` that is signal rather than noise** must contain: the failing assertion with *actual vs expected values*; the inputs/fixture that triggered it; the minimal causal chain (action → policy → contract → line that produced the wrong value); the diff since the last green run if any; and 1-3 ranked hypotheses. It must *omit* full stack traces, framework internals, repeated logs, and anything I already read this session.

**Preventing the graph from becoming a context hog:** ids instead of bodies by default; depth 0 by default; hard caps with cursors; session-aware deltas ("you already inspected these 6 nodes; here is what changed"); summaries precomputed and cached by the compiler; never a whole-graph dump; prefer answering a question over returning data.

## 5. Human readability and the file-format decision

**Syntax principles:** one construct per concept; names are the API (stable ids like `Team.inviteMember`); explicit over implicit (no file-based routing magic); locality (everything about an action in one place); `intent:` as a first-class field in the IR so PMs write it and agents read it; contracts in a plain TS-subset expression language; no metaprogramming; deterministic formatting, one field per line, diff-friendly.

**Format verdict:**
- **Structured YAML/JSON as source:** no. No types, no expressions for contracts, agents make indentation/quoting errors, no refactoring tools.
- **Graph DB as source of truth:** no. Not diffable, not reviewable in a PR, not git-native. The graph is a *derived index*, not the source.
- **New `.al` file format:** readable, but you must build LSP, formatter, highlighter, and editor plugins, and you pay the full no-training-data penalty. Defer.
- **TypeScript-embedded declarative DSL:** recommended for Stage 2. Add a read-only Markdown/graph projection for PMs.

**Worked example** (`members/inviteMember.ts`):

```ts
import { action, event, workflow, policy } from "agentlang";
import { Team, Member, Invitation, Email, Role } from "../entities";

export const MemberInvited = event("MemberInvited", {
  payload: { invitationId: Invitation.id, teamId: Team.id, email: Email },
});

export const InviteMember = action("Team.inviteMember", {
  intent: "An owner or admin invites a person by email. Re-inviting a pending email resends; inviting an existing member is an error.",
  input:  { teamId: Team.id, email: Email, role: Role.exclude("owner") },
  output: Invitation,
  policy: policy.allow(({ actor, input }) =>
    actor.membership(input.teamId).role.in("owner", "admin")),
  requires: {
    notAlreadyMember: ({ input, db }) =>
      db.Member.none({ teamId: input.teamId, email: input.email }),
  },
  ensures: {
    pendingForEmail: ({ result, input }) =>
      result.email === input.email && result.status === "pending",
    eventEmitted: ({ events }) => events.emitted(MemberInvited),
  },
  effects: ["db:write", "email:send"],
  transaction: true,
  run: async ({ input, db, actor, emit }) => {
    const inv = await db.Invitation.upsert({ teamId: input.teamId, email: input.email },
      { role: input.role, invitedBy: actor.id, status: "pending" });
    emit(MemberInvited, { invitationId: inv.id, teamId: inv.teamId, email: inv.email });
    return inv;
  },
});

export const InviteFlow = workflow("InviteFlow", {
  on: MemberInvited,
  steps: [
    step.email(Email.templates.Invite, ({ payload }) => ({ to: payload.email })),
    step.waitFor("InvitationAccepted", { timeout: "7d", onTimeout: Invitation.expire }),
  ],
});
```

From this the compiler derives: `POST /teams/:teamId/invitations`, request validation, the Prisma model and migration for `Invitation`, OpenAPI, the event type, a queue consumer for `InviteFlow`, and tests: policy denial for a `member` role, `notAlreadyMember` precondition failure, happy path asserting `ensures` and event emission, timeout path. A PM can read `intent`, `policy`, `requires`, `ensures`. An agent edits by `modify_contract("Team.inviteMember", "requires.notAlreadyMember", ...)` or by editing the file; either way the IR is regenerated.

## 6. AgentCodeBench, designed for a skeptic

**Task set:** 100 tasks, 5 categories x 20: feature add (RBAC, cursor pagination, soft delete, rate limit, audit log); bug fix (validation, race condition, N+1, timezone, off-by-one); refactor/migration (rename field with migration, split service, swap auth provider); third-party integration (Stripe webhook, S3 upload, OAuth, email); ops (idempotency keys, metrics, retries). Each task is a PM-style ticket with **hidden acceptance tests at the HTTP level** (black-box, stack-agnostic) plus a hidden regression suite. Three repo sizes: ~2k, ~15k, ~60k LOC.

**Baselines:** one seed app implemented idiomatically in Express+Prisma, NestJS+Prisma, FastAPI+SQLAlchemy, Encore.ts, Convex, and AgentLang. All six must pass the same HTTP acceptance suite before the benchmark starts (behavioral equivalence is non-negotiable and expensive). Baseline implementations are written or audited by people outside the AgentLang team.

**Arms (the 2x2 that makes results attributable):** (A) baseline stack, standard tools; (B) baseline stack + the semantic-graph MCP (Stage 1 works on plain TS); (C) AgentLang without graph; (D) AgentLang + graph. If B captures most of the gain, the language is not the product; the graph is.

**Controls:** same model (at least three: Claude, GPT, one open model), same pinned harness (Claude Code and one OSS harness such as OpenHands), same system prompt, same tool-call budget, same wall-clock cap, fixed temperature, **N=5 runs per task per arm** with 95% confidence intervals (run variance is large). The DSL spec in context is charged to the AgentLang arms.

**Metrics:** pass@1 on hidden tests (primary); change-correctness (hidden regressions plus blinded rubric review for security and scope creep); tokens split into input/cached/output; tool calls; build/test runs; wall time; dollar cost; stuck rate; diff size; and a blinded human readability score on the diffs.

**Confounds to neutralize:** "less code means fewer tokens" is tautological, so report tokens *per successful task* and *on the jointly-solved subset*, and separate output tokens (where less code helps) from input tokens (where orientation helps). Benchmark-authored-by-vendor bias: publish tasks, pre-register the analysis, accept third-party tasks, and keep a **held-out task set authored after the language and primitive set are frozen** so primitives cannot be tuned to the benchmark. Syntactic-error rate is reported separately to expose the training-data penalty.

**What would convince me:** pass@1 up by at least 15 absolute points with non-overlapping CIs across all three models, plus at least 30% fewer tokens on the jointly-solved subset, plus no regression in blinded readability. A 60% token reduction at equal pass rate would not convince anyone; a pass-rate gain is the thing you cannot get by simply writing less code. Publish the losses too.

## Commercial implication in one paragraph

Arm B is a shippable product on its own: a compiler-maintained semantic layer plus MCP/CLI over *existing* TypeScript repos. It is open-sourceable for individuals (local index, single repo) and chargeable for enterprises (monorepos, hosted index, SSO, policy enforcement, audit of agent changes, private primitives library). It de-risks the language bet because it generates the usage logs needed to decide which primitives deserve to exist.

## What I, as an agent, would actually want, in priority order

1. A **trustworthy, always-fresh oracle** for "where is X, who depends on X, how does this repo do Y," with hard token caps and ids-not-bodies, on my existing TS repo, with no language change.
2. **Root-cause-collapsed diagnostics** and an `explain_failure` that gives actual-vs-expected and the causal chain instead of a stack trace.
3. A fast `check` that runs only **affected** tests and returns structured results.
4. **Conventions enforced with autofix** so I never have to learn them from a reviewer.
5. **Derived layers** (schema → types → validation → routes → OpenAPI) so mismatches cannot exist.
6. A recorded `intent` and decision log per entity/action, so I stop re-asking the same ambiguity questions.
7. **Contracts as first-class** with generated tests, accepting that they test what was written, not what was meant.
8. **Primitives with encoded pitfalls** (webhook raw body, idempotency, cursor pagination), which is where third-party integration failures actually come from.
9. Only after all of the above, and only if arm C beats arm B: a new syntax. If it is a TS-embedded DSL, I can use it on day one; if it is a `.al` file, I will need the spec in every context window for a long time.