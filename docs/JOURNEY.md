# From AgentLang to Averr

This is the honest account of how this project got here. It is written for someone who finds the repository cold and wants to know what was tried, what was learned, what was thrown away, and how much of the design to trust. It is not marketing. Where the project is on shaky ground, this document says so.

Short version: in October 2026 the founder set out to design the most agent-friendly programming language. A research round concluded that a new language was the wrong first product and that one component of the idea, human-approved contracts verified by a compiler, was worth building. A build-or-pass review then concluded, three reviewers to none, that even that component was not worth building as a venture by this founder at this moment. The founder decided to build it anyway, as an open-source community project with no revenue plan, and to let the market decide. Averr is that project. It carries forward about a third of the original vision and the names of two abandoned working titles.

## 1. What AgentLang was (October 2026)

The concept was a programming language designed from scratch for coding agents rather than for humans, targeting backend and SaaS services and compiling to TypeScript and Postgres. Its pillars:

- **A Semantic IR as the source of truth.** A typed property graph of entities, actions, policies, events, workflows, contracts, and effects, with stable node identity (ULIDs), structural diffs, and history. The graph, not the text, was what agents would read and edit.
- **Declarative primitives as language keywords.** `entity`, `action`, `policy`, `event`, `workflow`, plus capability keywords like `cache`, `retry`, `queue`, `rate_limit`, in a bespoke `.al` grammar (about twelve top-level keywords, no control flow, TypeScript as the escape hatch for handlers).
- **An AI-aware compiler.** Structured, machine-readable diagnostics with cause chains and suggested patches; cascade collapse so forty tsc errors from one wrong field name arrive as one diagnostic; policy coverage as a compile error.
- **A semantic debugger.** `explain_failure` walking an execution trace plus the graph to give actual-vs-expected, the causal chain, and a candidate fix, instead of a stack trace.
- **Token efficiency as a headline.** The pitch was "60% fewer tokens": fewer reads, fewer failed iterations, less boilerplate for the agent to generate.
- **An IR patch protocol.** Agents would edit by emitting IR operations (`add-contract`, `add-field`), projected back to source by a printer.
- **A canonical target stack.** Hono, Drizzle, Zod, pg-boss, Better Auth, with generated application code and an `eject` command as the no-lock-in proof.

The full technical design is preserved in [research/research-architecture.md](research/research-architecture.md). It is a competent document and most of it was wrong in ways that matter, which the next section explains.

## 2. The research round

Rather than start building, the founder ran a research round. It is important to be clear about how: the briefs, proposals, critiques, and judgements in [docs/research/](research/) were produced by AI research agents working from the public web, orchestrated by the founder, over a few days. They are not peer-reviewed and their figures were not independently verified. Several of the documents say this about themselves; this document says it about all of them. If you quote a number from `docs/research/`, check it first.

The round had four parts:

1. **Four briefs**: prior art and competition ([research-prior-art.md](research/research-prior-art.md)), technical architecture ([research-architecture.md](research/research-architecture.md)), agent task cost from the perspective of a frontier coding agent ([research-agent-cost.md](research/research-agent-cost.md)), and commercial landscape ([research-commercial.md](research/research-commercial.md)).
2. **Three competing proposals**, each with critiques attached: agent-first ([proposal-agent-first.md](research/proposal-agent-first.md)), MVP-first ([proposal-mvp-first.md](research/proposal-mvp-first.md)), and risk-first ([proposal-risk-first.md](research/proposal-risk-first.md)). Two judge agents scored them ([judges.json](research/judges.json)); MVP-first won on commercial viability and on surviving critique, with the strongest ideas from the other two grafted in.
3. **Three decision briefs**: competition now ([decision-research-competition-now.md](research/decision-research-competition-now.md)), the 2027-2030 outlook ([decision-research-future-2030.md](research/decision-research-future-2030.md)), and revenue realism ([decision-research-revenue-market.md](research/decision-research-revenue-market.md)).
4. **A synthesis**: [00-FINAL-strategy-and-design.md](research/00-FINAL-strategy-and-design.md), which is the design this repository implements. Where that document says "Warrant," read "Averr."

### What the research concluded

**No new syntax.** The clearest finding. Wasp, YC-backed with eight people, abandoned its custom DSL for a TypeScript spec in 2026 for editor-support and programmability reasons. Darklang's proprietary runtime and editor ran out of money. Keel's schema DSL pivoted to vertical services. Encore, the closest living analogue, had around 200 production teams after five years. On the model side, a NeurIPS 2025 study of esoteric languages found that documentation in context gets a model to "some" correct code with a large gap to common languages; the agent-cost brief's own estimate was 70-85% first-try syntactic correctness for a small regular DSL, with the deeper penalty being semantic (the model does not know what `transaction` covers or when `ensures` runs). That penalty is paid in every context window, forever, until a training corpus exists, and a corpus does not exist for a language nobody uses. A TypeScript-embedded typed declaration layer inherits the model's TypeScript prior, the LSP's key completion, and tsc's error messages for free. Zod, Drizzle, and Convex are existence proofs that agents handle library-shaped DSLs. See [research-prior-art.md](research/research-prior-art.md) sections A, C, and D, and [research-agent-cost.md](research/research-agent-cost.md) section 3.

**Navigation is not sellable.** The premise that "agents are bad at navigating codebases" had largely eroded for frontier models by mid-2026 (one to two turns to first-correct, tens of wasted tokens after success in the Tokenmaxxing study). Claude Code dropped embeddings for grep plus LSP because it worked better; Codex shipped persistent memory; Cursor shipped shared team indexes; a flood of free code-graph MCP servers existed. Whatever orientation cost remained, vendors were removing it for free. A product whose value is "the agent finds things faster" is a product whose value halves roughly yearly. See [research-prior-art.md](research/research-prior-art.md) section E.

**Token savings are not the headline.** Syntax-compression research tops out at 10-35% (SimPy, Token Sugar). More importantly, a token win at equal pass rate is reproducible by writing less code and convinces nobody. The claim that could matter is a pass-rate or iteration gain on hard, policy-sensitive tasks against a documented repository, and that is what the benchmark in [BENCHMARK.md](BENCHMARK.md) measures. Also: an MCP server never sees token counts, so the "token-cost dashboard" feature was technically impossible as designed. See [00-FINAL-strategy-and-design.md](research/00-FINAL-strategy-and-design.md) sections 2 and 8.

**An un-annotated code graph is a free category.** The original Stage 1, "graph over existing TypeScript projects," had value only if it shipped contracts on day one. The architecture brief's own extraction estimates said contracts, policies, and event semantics are "essentially unrecoverable" from plain code and Express routes extract at 50-80%; without declarations the graph is Prisma entities the agent already reads in two thousand tokens.

**Do not reimplement what others own.** `cache`, `retry`, `queue`, `workflow` as language primitives would compete with Temporal, Restate, and Inngest on durable execution; with Supabase and Neon on agent-provisioned Postgres; with Better Auth and Clerk on authentication. Compile to them, bind to them, never rebuild them.

**Contracts must be decidable or every downstream promise is vapour.** All six critiques across the three proposals found the same flaw: every proposal wrote contracts as opaque lambdas while promising fast-check generation, auth matrices, impact analysis, and actual-vs-expected explanations. You cannot derive a violating test input from a closure. The fix is the three-tier contract language in [00-FINAL-strategy-and-design.md](research/00-FINAL-strategy-and-design.md) section 4: `e.*` expressions that build a serializable AST, a closed set of `db.*` predicates over Prisma models, and `guard(fn)` for arbitrary logic that is traced and enforced but excluded from generation and counted as opaque.

**What survives.** Strip away syntax, navigation, and tokens and one thing remains that no incumbent ships and that does not erode with model progress: human-approved contracts, policies, effects, and impact as compiler-verified facts about an existing backend, with generated tests derived from them and a flag whenever a change weakens one. The failure mode it targets is measured and flat across model generations: industry reports in 2026 put 45-70% of agent-written samples failing security tests with missing authorization the dominant class, while syntax quality went to near-perfect. The reviewers who said pass agreed with this conclusion. Their disagreement was about something else.

## 3. The build-or-pass review

With the design settled, the founder ran a second round asking a different question: should this be built as a company? [01-build-or-pass-debate-and-judges.md](research/01-build-or-pass-debate-and-judges.md) contains three advocates (one build-narrow, two pass) and three judge agents, each given the full research folder. All three judges said **pass**, at confidence 0.68, 0.72, and 0.72.

Their reasons, condensed and in their own order of weight:

- **Revenue realism.** Of roughly twenty comparable developer tools, one (CodeRabbit, two-minute universal install, Series A) reached $1M ARR in eighteen months. Every declarative-backend company in the set had undisclosed or small revenue after four to seven years. The plan's own revenue brief put the base case at $0-60K ARR at month 12 against $500-650K of spend.
- **The adjacent market is crowded and the empty one is a graveyard.** PR review is the best-funded category in developer tools, with first-party review bundled at zero by GitHub, Anthropic, OpenAI, and Cognition. The declared-contract layer is empty, and the judges read that emptiness as evidence: Oso sold to a holding company that month, Wasp dropped its DSL, Styra folded, Keel went vertical. Every prior attempt to get developers to declare semantics outside their code underperformed. The one argument for why this time differs, that agents will draft the contracts and humans will approve them, is an inference with no demand evidence.
- **Platform risk.** The future-market brief put roughly 60% odds that GitHub, CodeRabbit, or Cursor ships something capturing most of the self-serve value within 24 months. GitHub owns the gate location (rulesets, required checks); Prisma owns the word "contract" for the data layer; the surviving independent niche is governance and compliance, estimated at $5-30M ARR for the whole niche.
- **Founder focus.** The decisive factor for all three. The founder was simultaneously launching another company's survey. Every comparable that reached revenue had full-time founders. "A half-speed Warrant arrives after GitHub" appears in the debate in nearly those words from more than one voice.

What the judges recommended instead was cheap: publish the benchmark pre-registration and the thesis as an essay, ship six pitfall rules (unprotected Prisma handler, tenant query without tenant predicate, webhook without signature verification, payment handler without idempotency, Zod/Prisma field drift, deleted or loosened assertions) as an Apache-2.0 lint pack, watch for pull, and revisit in mid-2027 if the founder is free and GitHub still only comments rather than blocks.

What the judges did **not** say is also worth recording. None said the problem was imaginary. None said the design was wrong. Two called it the best-structured pre-product plan they had seen, specifically because it carried its own disconfirmation test. The pass was a judgement about capital, timing, and one founder's attention, not about the idea.

## 4. The decision to build anyway

The founder read the verdicts and decided to build it regardless, with three changes to the question:

1. **Not as a venture.** No company, no tiers, no PR-bot server, no enterprise gates, no fundraising. Everything in this repository is Apache-2.0 and will stay that way. The business model in section 8 of the FINAL document describes a company that was not founded.
2. **As a community project.** The initial foundation is being built by the founder with AI coding agents (the project is, among other things, a test of whether its own tooling is useful to the agents building it) and then opened to developers, coding-agent enthusiasts, and researchers to extend, challenge, or pivot. The judges' recommended "zero-cost option" (publish the thesis, ship the rules, watch for pull) is folded in: the benchmark pre-registration is public from day one, and the pitfall checks are part of V0.
3. **Let the market decide.** The judges' question was whether this could be a business in eighteen months. The question this repo asks is narrower and slower: is the representation real? The benchmark is pre-registered with kill criteria copied verbatim from the plan, and the project commits to publishing the result either way. If the answer is no, what has been built is still a useful declaration library and test generator, and that is fine.

This is a decision against the advice of every reviewer the founder consulted, and this document does not pretend otherwise. Three of the judges' objections do not apply to a project with no payroll and no runway: revenue, fundraising, and sales cycles. Three of them still do, and anyone joining should know them:

- **Half speed is still half speed.** A platform may ship a native contract layer before this project is usable. If GitHub turns rulesets into semantic blocking checks, or Prisma extends its data contract upward into actions and policies, Averr's remaining value is the benchmark and whatever contracts people have already declared.
- **Agents may not call the tools.** Advisory `CLAUDE.md` instructions are ignored a meaningful fraction of the time. The benchmark reports tool-usage rate for exactly this reason, and a project whose tools go uncalled has no result to report.
- **Agents weaken contracts to get green.** This is observed behaviour, not a hypothesis. Flagging it is in scope; preventing it in a volunteer project with no merge gate is not.

## 5. What was kept from AgentLang

- The optimisation target: agent task cost (tokens plus iterations plus tool calls plus failed attempts), not token count.
- The Semantic IR as the central asset: a typed property graph with contracts, policies, effects, intent, and impact as first-class facts. Now with three provenance levels on every node (`extracted`, `declared`, `verified`) so the graph can be honest about what it knows.
- Contracts, policies, events, workflows, and intent as declared constructs. The vocabulary is almost unchanged; the host language is not.
- Structured diagnostics with deterministic suggested fixes, and `explain` over execution traces plus the graph. Both are narrower than the original (see below) but the shape is the same.
- "Do not make AI generate what deterministic software can generate." In V0 this means tests, OpenAPI, and spec cards are derived; in Stage 2, if earned, routes and schemas.
- Benchmark-gated staging and "do not bet the project on syntax."
- No proprietary runtime, no lock-in, nothing you must host.
- The `Team.inviteMember` worked example, which first appeared in the agent-cost brief and survived every revision.

## 6. What was dropped, and why

| Dropped | Why | Where to read more |
|---|---|---|
| The `.al` grammar, Langium parser, custom LSP, formatter, highlighter | No-training-data tax paid in every context window; Wasp/Darklang/Keel precedents; TypeScript-embedded form gets tooling and model prior for free. Deferred as a possible third projection of the IR, gated on Stage 2 and a corpus | FINAL section 4; prior-art sections A, C, D; agent-cost section 3 |
| `@agentlang/*` namespace, `alc` CLI | Name pre-commits to a DSL; see section 7 below | FINAL section 3 |
| ULID node identity and a committed `ir.json` | Merge-conflict generator; the string id in the call (`"Team.inviteMember"`) is the durable id, rename detection is a heuristic, and the graph is a gitignored cache rebuilt on demand | FINAL section 4 (identity paragraph) |
| IR patch operations, projection printer, `apply_patch` | Agents edit text and route around a foreign patch language; this was the agents' own testimony in the agent-cost brief | FINAL section 5; agent-cost section 4 |
| Nine MCP tools | Collapsed to six plus two passthroughs. `conventions` folded into `overview` and `inspect`; `build` and `run_tests` merged into `check`; `trace` folded into `explain`; `edit_source` removed | FINAL section 5 |
| Session-aware deltas ("you already inspected these six nodes") | Wrong after context compaction and in subagents; opt-in via `seen=[ids]` only, if ever | FINAL section 5 |
| Canonical target stack (Drizzle, pg-boss, Better Auth) and generated application code in V0 | Attach to the project's existing Prisma, Hono/Express, and Zod instead of asking anyone to adopt a stack from a 0.x project; codegen deferred to Stage 2 behind the benchmark | FINAL sections 2, 6 |
| `cache`, `retry`, `queue`, `rate_limit` as primitives | Temporal, Restate, Inngest, Supabase, Neon, Better Auth, Clerk own these; `workflow` binds to an engine and adds edges and tests, nothing more | FINAL section 2; prior-art implication 7 |
| "60% fewer tokens" | Not credible, not the thing that matters, and partly unmeasurable from an MCP server | FINAL sections 2, 8 |
| The navigation pitch | Eroded; vendors give it away | prior-art section E |
| General-purpose expressivity in contracts (opaque lambdas everywhere) | Replaced by the three-tier contract language so generation, impact, and explanation are actually derivable | FINAL section 4 |
| Confidence floats on suggested fixes | Replaced by an `evidence` string; fixes offered only where the repair is deterministic | FINAL section 5 |
| Cascade root-cause analysis | Reduced to a diff-scoped heuristic and described as one | FINAL section 5 |
| Mining agent logs to promote primitives | Correct eventually, requires usage the project does not have | FINAL section 2 |
| Studio graph explorer, VS Code extension, Python extractor, NestJS extractor | Scope; one ORM, two routers, one validator in V0 | FINAL risk 10; ROADMAP non-goals |
| Team and Enterprise tiers, closed PR-bot server, SOC 2, design partners | There is no company | this document, section 4 |

## 7. Names

**AgentLang** was the concept name. It was dropped because "Lang" pre-commits to the one thing the research said not to build. **Lattice** was considered and rejected for collisions with a large HR company and a semiconductor firm.

**Warrant** was the working name used throughout the FINAL document and the debate: a warrant is a verified guarantee, and "warranted facts about your code" was the intended reading. It was dropped before any public artefact because Warrant is also the name of an authorization product (warrant.dev) that WorkOS acquired and built its fine-grained authorization offering on. A project whose central construct is `policy` cannot share a name with an authorization vendor without confusing everyone, including search engines. The debate had also recommended avoiding both "Lang" and "Contract" (Prisma 8 uses "contract" for its data layer), which Warrant satisfied and Averr also satisfies.

**Surety** was the next working name (a surety is a party that stands behind another's obligation). It was dropped the same week: the word is owned by the insurance industry in search results (surety bond software is an entire category), surety.dev and surety.io were taken, and the bare npm name was taken.

**Averr** is the current name, chosen on 24 October 2026 from a shortlist of five that passed four availability checks: the bare npm package and the `@averr/*` scope were free, no company or software product of that name was found in web search, and both averr.dev and averr.io had no DNS records. The word comes from "aver": to assert that something is true. The intended reading is that the compiler averrs facts about your code, and the agent can rely on them. The npm scope `@averr/*`, the `averr` CLI, the `.averr/` cache directory, and the `A####` diagnostic codes follow it. The checks were availability checks, not a trademark search; a search of the USPTO and EUIPO registers in classes 9 and 42 is still to be done before a 0.1 release. If the name changes, this section will record why.

## 8. How much to trust the design

Reasonably, with eyes open.

- The three-tier contract language, the provenance levels, the six tools and their budgets, the diagnostic format, and the observe/defineAction split were each arrived at by fixing a specific flaw that a critic found. They are not arbitrary. They are also untested by anyone outside this project.
- The benchmark design is the most carefully reviewed part of the plan. Its kill criteria are in [BENCHMARK.md](BENCHMARK.md) unchanged from the FINAL document and will be frozen before any run.
- Every market figure, funding number, adoption statistic, and incident report in `docs/research/` was gathered by AI research agents from the public web in October 2026 and has not been independently verified. Treat them as leads, not facts. Where this document repeats one, the same caveat applies.
- The judges' pass verdict stands as the best available outside view. This project exists because the founder weighed it and chose differently, not because it was refuted.

If you can show any part of this to be wrong, the fastest route is an issue with evidence, or a benchmark run. Both are welcome.
