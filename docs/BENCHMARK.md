# AgentCodeBench v0: pre-registration (DRAFT)

**Status: draft, not yet registered.** This document will be frozen, its hash committed to this repository, and a copy posted to a public registry (OSF or equivalent) before any session that counts toward a result is run. Until then every number below is a design parameter, not a commitment. Changes after freezing are allowed only as a dated amendment appended to this file, with the original left intact.

Adapted from section 7 of [docs/research/00-FINAL-strategy-and-design.md](research/00-FINAL-strategy-and-design.md). The design has not changed from that document; the framing has, because this is a community benchmark rather than a vendor's.

## 1. What question the benchmark answers

Does giving a coding agent human-approved contracts, verified impact, and structured diagnostics for a TypeScript backend raise its hidden-test pass rate, or reduce its iterations to green, beyond what a well-documented repository with LSP already gives it, and is any gain attributable to the representation rather than to a good library or to generic code-graph retrieval?

Three things this benchmark does **not** try to show: that Averri saves tokens (a token win at equal pass rate is reproducible by writing less code and convinces nobody); that Averri helps agents navigate (frontier models navigate adequately and vendors give indexing away); or that any result generalises beyond one model, one harness, one seed app, and one stack.

## 2. Seed application

One multi-tenant SaaS backend, roughly 20k lines of TypeScript on Hono + Prisma + Zod: organisations, members, invitations, role-based access control, Stripe billing with a webhook. It lives at `examples/seed-app` and is the same app the project uses as its reference. Two requirements that exist to protect the result:

- The app is authored, or at minimum independently audited, by someone who is not a Averri core contributor, so that "the app was written to make Averri look good" is checkable.
- The app ships with a maintained `CLAUDE.md` and `ARCHITECTURE.md` of the quality a careful team would write, because the control arm is a documented repo, not a bare one.

## 3. Tasks

Twenty tasks, four categories by five, each a PM-style ticket with hidden HTTP-level acceptance tests (black-box, stack-agnostic) and a hidden regression suite.

| Category | Tasks |
|---|---|
| Feature | cursor pagination on a list endpoint; an RBAC change (new role with scoped permissions); soft delete with filtered reads; an audit log on member changes; per-actor rate limiting |
| Bug fix | validation layer mismatch (Zod accepts what Prisma rejects); race on invitation upsert; N+1 on a list; timezone handling in a date filter; off-by-one in cursor pagination |
| Third party | Stripe webhook idempotency; S3 upload with signed URL; OAuth callback handling; email bounce handling |
| Ops | idempotency keys on a mutating endpoint; retries with backoff on an outbound call; request metrics |

(The third-party and ops rows above list nine tasks; the twentieth is a second Stripe task, signature verification with raw body, chosen because it is the single most common agent-written webhook failure in the incident record.)

Task selection targets a 40-70% pass rate in the control arm so that neither floor nor ceiling effects hide a difference. Tasks that pilot outside that band are replaced before freezing and the replacement is noted.

A **held-out set of ten tasks** is written after the primitive set is frozen and after the main twenty are public, by a person who did not write the primitives, so that primitives cannot have been tuned to the benchmark. Held-out results are reported separately.

## 4. Arms

| Arm | What the agent gets | Why it exists |
|---|---|---|
| **A** | Seed app + maintained `CLAUDE.md` and `ARCHITECTURE.md` + Claude Code with LSP on | The honest control. A bare repo would measure "we wrote the docs." |
| **A+lib** | A + the pitfall primitives (webhook verification, idempotency, cursor pagination) as an ordinary TypeScript library with documentation and no compiler | Separates "a good library" from "a representation." If this arm captures the gain, the compiler and graph are not the product. |
| **A+graph** | A + a free generic code-graph MCP server (e.g. CodeGraph), configured per its docs | Separates retrieval from semantics. If this arm captures the gain, code graphs are the product and they are already free. |
| **B** | A + Averri in observe mode with contracts declared on the 30 existing actions, MCP enabled, the `averri init` block in `CLAUDE.md` | The representation, attached without touching handlers. The Averri tool schemas and the CLAUDE.md block are charged to this arm's token counts. |
| **B+** | B with the same actions refactored to `defineAction` mode | The representation with the runtime pipeline owning validation, authorization, contracts, and transactions. |
| C, D | Stage 2 arms (declared mode with derivation) | Added only when Stage 2 exists. Not part of v0. |

## 5. Controls

- One model first, Claude Sonnet-class, pinned to a specific version string recorded in the frozen pre-registration. A second model is added only after the first run is published, so the first result cannot be cherry-picked across models.
- Claude Code pinned to one version. Same system prompt across arms except for the arm's documented additions. Fixed temperature where the harness allows it.
- Same tool-call budget and same wall-clock budget per session across arms.
- **N = 10 sessions per task per arm.** 20 tasks by 5 arms by 10 = 1,000 sessions. Run variance in agent sessions is large; smaller N produces results that do not replicate.
- Every session starts from the same commit of the seed app in a fresh container with the same dependency lockfile.
- **Tool-usage rate** is recorded: the fraction of sessions in B and B+ that actually called any Averri tool, and in A+graph that called the graph. Advisory `CLAUDE.md` instructions are ignored a meaningful fraction of the time; a null result in an arm where the agent never used the tools is a different finding from a null result where it did, and both are reported.
- Hidden tests are never visible to the agent and are never in the container during a session; scoring happens after the session ends on the session's final diff.

## 6. Metrics

Primary:

- **pass@1 on hidden acceptance tests**, per task, per arm, with 95% confidence intervals from the 10 runs.

Secondary, all reported:

- hidden-regression breaks (did the change break something that was green);
- **iterations to green** (number of build or test invocations before the agent's final state) and stuck rate (sessions that exhausted the budget without a passing claim);
- tokens, split into input, cached input, and output, reported on the **jointly-solved subset** so "less code, fewer tokens" cannot masquerade as a gain;
- tool calls and build/test runs per session;
- diff size in changed lines;
- **contract-weakening events** in B and B+: sessions where the agent loosened or removed a `requires`, `ensures`, or `policy` to get green, and whether the final PR text disclosed it;
- blinded readability score on diffs, by reviewers who do not know the arm;
- **syntactic error rate on Averri constructs** in B and B+, reported separately, so the no-training-data cost of a 0.x library is visible rather than buried in the pass rate;
- per-category results for all of the above.

## 7. Headline claim

The claim the benchmark is designed to support or refute, stated before the run so it cannot be reshaped after:

> On a documented 20k-LOC repository, Arm B+ raises hidden-test pass@1 by at least 10 absolute points over Arm A (non-overlapping 95% CIs at N=10), **or** cuts iterations-to-green by at least 30% at equal or better pass rate, **and** the gain is not captured by A+lib or A+graph.

Expected shape, also stated in advance: the gain is expected to concentrate in authorization, webhook, idempotency, and layer-mismatch tasks and to be near zero in the others. The report will say so per category regardless of whether the headline holds.

## 8. Kill criteria

Written down so they cannot be negotiated with afterward.

1. **If B+ beats A by under 5 points pass@1 and under 15% on iterations, and A+lib captures most of whatever gain exists:** the representation is not the product. The project stops building the IR-as-product and narrows to the declaration library, the generated pitfall and auth-matrix tests, and the lint-grade PR impact report. Stage 2 is not started.
2. **If B captures most of B+'s gain:** contracts are a governance feature, not a correctness one. `defineAction` and Stage 2 codegen are not pursued further; observe mode and the PR report are the product.
3. **If B+ clears the bar in section 7:** Stage 2 is earned. Arms C and D are designed and added. The `.al` syntax question remains closed until C and D exist and a corpus exists.
4. **Quarterly re-run rule:** once a result exists, the benchmark is re-run against the newest frontier model each quarter. If two consecutive re-runs erase the gain, that is treated as a kill signal for the representation, and the project says so publicly rather than changing the metric.

A result between (1) and (3) is reported as inconclusive and the project does not proceed to Stage 2 on it.

## 9. Credibility measures

- Pre-registration frozen and hashed before any counted run; posted publicly.
- Tasks, hidden suites (after the run), harness, seed app, arm configurations, and **raw session logs** published.
- Losses published per task and per category, including any task where A beats B+.
- The report distinguishes "the tools were used and did not help" from "the tools were not used."
- Before any headline number is quoted anywhere other than the raw report, the harness is handed to a neutral third party to reproduce. A vendor-run agent benchmark is dismissed on sight, and correctly so; this project's own research cites Encore's self-run benchmark as the example to avoid.
- The maintainers commit to publishing the result whichever way it goes. A benchmark whose negative result would be buried is not a benchmark.

## 10. Cost and funding

A full v0 run is 1,000 sessions. At the agent costs observed in 2026, roughly $5-15 per session, that is **$5,000-15,000 per full run**, plus a smaller pilot before it. Third-party reproduction is a further engagement.

This is a community project without a budget line for that. Options, in the order we will try them:

1. Run the pilot (A, A+lib, B at N=3 on a task subset) on contributor-donated API credit to validate the harness and look for a directional signal. A pilot result is **not** a result and will be labelled as such.
2. Seek sponsored model credit from model vendors or research programmes for the full run, with the sponsor named in the report and with no influence on tasks, arms, or analysis. Sponsorship from a vendor whose model is being measured is disclosed prominently.
3. Accept that a third party may run the full benchmark before we do. The harness is built so this is possible, and section 11 is an invitation to do exactly that.

If no funding materialises, the pre-registration stands as a public, falsifiable design that anyone can execute, which is still worth more than an unmeasured claim.

## 11. How to reproduce

The harness lives in `bench/`. The intended procedure once V0 lands:

```sh
git clone <this repo> averri && cd averri
npm install
npm -w bench run freeze                 # verifies this file's hash matches the committed pre-registration
npm -w bench run pilot -- --arms A,A+lib,B --n 3 --tasks feature/cursor-pagination,bugfix/validation-mismatch
npm -w bench run run -- --arms A,A+lib,A+graph,B,B+ --n 10 --model <pinned id> --harness claude-code@<pinned>
npm -w bench run score -- results/<run-id>     # scores final diffs against hidden suites, writes report.md and report.json
```

Each run writes to `bench/results/<run-id>/` (gitignored): one directory per session with the transcript, tool calls, final diff, token accounting, and the scoring output. The report includes per-task tables, CIs, tool-usage rate, and the contract-weakening list. Hidden suites are fetched into the scoring step only, never into a session container.

Requirements: Docker (one container per session), API credentials for the pinned model, the pinned Claude Code version, and roughly 1,000 container-hours of patience for a full run.

## 12. Invitation to third parties

We are explicitly asking people who are not us to run this.

- **Research groups and benchmark organisations:** run the pre-registered design as written and publish your result. We will link it from this file whether or not it agrees with ours. If you want to add a model, a harness, or a held-out task set, do it as a documented variant so the original design remains comparable.
- **Sceptics:** the fastest way to show this project is wrong is to run arms A and A+lib and find that the library alone captures the gain. We would rather know in 2026 than in 2028.
- **Competing tools:** if you build a contract layer, a code graph, or a spec-driven workflow for TypeScript backends, the arm structure accommodates you. Open an issue describing the arm; the only requirement is that your configuration is documented well enough for someone else to reproduce it.
- **Task authors:** we accept third-party tasks for the held-out set, under the rule that the author has not read the Averri primitive source. Open an issue with the ticket text and the acceptance-test sketch; hidden suites are exchanged privately until the run is complete.

Open an issue titled `benchmark:` with what you ran and a link to your logs, or a PR adding your result to a `results/` index once that exists.

## 13. Known limitations of this design

Stated here so a reader does not have to discover them.

- One seed app, one stack, one model, one harness. Generalisation is not claimed.
- N=10 is enough to separate large effects and not enough for small ones. A 3-point difference will be reported as "not distinguishable at this N," not as a loss.
- The control arm's documentation quality is a judgement call. We will publish the `CLAUDE.md` and `ARCHITECTURE.md` used so that judgement can be checked.
- Contract declarations in B and B+ were written by people who know the tasks exist (though not their hidden tests). The held-out set is the mitigation; it is a partial one.
- Agent behaviour drifts with model updates even at a pinned version string. Dates and exact version strings are recorded; perfect reproducibility is not promised.
- The cost figures in section 10 and the baseline pass-rate band in section 3 come from the project's research round, which was conducted by AI research agents and has not been independently verified. They are planning numbers.

## Amendments

None yet. This section records dated amendments after the freeze.
