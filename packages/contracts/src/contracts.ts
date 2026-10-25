/**
 * Phase evaluation over lowered `ContractRecord`s (from the `__averri` marker of a declaration):
 * one `PhaseRecord` per clause, tier order expr → predicate → guard (SPEC-CONTRACTS §6), every
 * clause evaluated, first failure reported.
 */
import { averriMeta, type Actor, type ContractRecord, type PhaseRecord, type PolicyDecl } from "@averri/core";
import { renderExpr, type ContractId, type RefPath } from "@averri/ir";
import { evaluateClause } from "./evaluator.js";
import { elapsed, runGuard } from "./guards.js";
import type { EvalEnv, EvaluatedEntry, PrismaLike, Row } from "./types.js";

/** The `requires`/`ensures` member of `PhaseRecord`. */
export type ContractPhaseRecord = Extract<PhaseRecord, { phase: "requires" | "ensures" }>;

export interface ContractEvalOptions {
  /** Client for tier-2 predicates (the transaction client in declared mode). */
  prisma?: PrismaLike | null;
  /** Client handed to guards: ALWAYS the plain client. Defaults to `prisma`. */
  guardPrisma?: PrismaLike | null;
}

export interface ContractOutcome {
  record: ContractPhaseRecord;
  ok: boolean;
  /** Human message for the violation body/trace (empty when ok). */
  message: string;
  dbCalls: number;
}

const TIER_RANK = { expr: 0, predicate: 1, guard: 2 } as const;

/** Stable sort: tier 1, tier 2, then guards; source order within a tier. */
export function orderByTier(records: readonly ContractRecord[]): ContractRecord[] {
  return [...records].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

function describeFailure(record: ContractRecord, undefinedRefs: RefPath[], errors: string[], guardError?: string): string {
  if (record.tier === "guard") return `${record.id} failed: ${guardError ?? "guard returned false"}`;
  const parts = [`${record.id} failed: ${renderExpr(record.expr!)}`];
  if (undefinedRefs.length > 0) parts.push(`undefined refs: ${undefinedRefs.join(", ")}`);
  if (errors.length > 0) parts.push(`evaluation errors: ${errors.join("; ")}`);
  return parts.join(" — ");
}

/**
 * Evaluates one contract record in the given phase. `phase` is the PhaseRecord phase (`requires` or
 * `ensures`; invariants and policies are recorded under the phase they are evaluated in).
 */
export async function evaluateContract(
  record: ContractRecord,
  phase: "requires" | "ensures",
  env: EvalEnv,
  options: ContractEvalOptions = {},
): Promise<ContractOutcome> {
  const started = performance.now();
  if (record.tier === "guard" || record.guard !== null || record.expr === null) {
    const guard = record.guard;
    if (guard === null) {
      const durationMs = elapsed(started);
      return {
        record: { phase, ok: false, contract: record.id, tier: "guard", durationMs },
        ok: false,
        message: `${record.id} failed: contract has neither an AST nor a guard`,
        dbCalls: 0,
      };
    }
    const run = await runGuard(guard, {
      input: env.input,
      actor: (env.actor ?? null) as Actor | null,
      self: env.self ?? null,
      old: env.old ?? null,
      result: env.result,
      prisma: options.guardPrisma ?? options.prisma ?? null,
    });
    return {
      record: { phase, ok: run.ok, contract: record.id, tier: "guard", durationMs: run.durationMs },
      ok: run.ok,
      message: run.ok ? "" : describeFailure(record, [], [], run.error),
      dbCalls: 0,
    };
  }
  let ok = false;
  let evaluated: Record<string, EvaluatedEntry> = {};
  let undefinedRefs: RefPath[] = [];
  let errors: string[] = [];
  let dbCalls = 0;
  try {
    const result = await evaluateClause(record.expr, env, options.prisma ?? null);
    // Fail closed: a clause whose evaluation raised errors never holds, whatever `not` did to it.
    ok = result.ok && result.errors.length === 0;
    evaluated = result.evaluated;
    undefinedRefs = result.undefinedRefs;
    errors = result.errors;
    dbCalls = result.dbCalls;
  } catch (error) {
    ok = false;
    errors = [error instanceof Error ? error.message : String(error)];
  }
  const phaseRecord: ContractPhaseRecord = {
    phase,
    ok,
    contract: record.id,
    tier: record.tier,
    evaluated,
    durationMs: elapsed(started),
  };
  if (undefinedRefs.length > 0) phaseRecord.undefinedRefs = undefinedRefs;
  return { record: phaseRecord, ok, message: ok ? "" : describeFailure(record, undefinedRefs, errors), dbCalls };
}

export interface PhaseFailureInfo {
  contract: ContractId;
  evaluated?: Record<string, EvaluatedEntry>;
  message: string;
}

export interface PhaseResult {
  records: ContractPhaseRecord[];
  /** The first failing clause in evaluation order, or null when every clause held. */
  firstFailure: PhaseFailureInfo | null;
  dbCalls: number;
}

/** Evaluates every record of a phase (tier order), never short-circuiting; reports the first failure. */
export async function evaluatePhase(
  phase: "requires" | "ensures",
  records: readonly ContractRecord[],
  env: EvalEnv,
  options: ContractEvalOptions = {},
): Promise<PhaseResult> {
  const out: ContractPhaseRecord[] = [];
  let firstFailure: PhaseFailureInfo | null = null;
  let dbCalls = 0;
  for (const record of orderByTier(records)) {
    const outcome = await evaluateContract(record, phase, env, options);
    out.push(outcome.record);
    dbCalls += outcome.dbCalls;
    if (!outcome.ok && firstFailure === null) {
      firstFailure = { contract: record.id, message: outcome.message };
      if (record.tier !== "guard") firstFailure.evaluated = outcome.record.evaluated ?? {};
    }
  }
  return { records: out, firstFailure, dbCalls };
}

/** Invariant records of an entity, evaluated against one row (`self` = the row). */
export async function evaluateInvariants(
  records: readonly ContractRecord[],
  row: Row,
  options: ContractEvalOptions = {},
): Promise<PhaseResult> {
  return evaluatePhase("ensures", records, { self: row }, options);
}

export interface PolicyEvaluation {
  allow: boolean;
  /** The policy's `allow` contract id (`Contract:<policy>.allow`). */
  contract: ContractId;
  tier: ContractRecord["tier"];
  evaluated: Record<string, EvaluatedEntry>;
  undefinedRefs: RefPath[];
  message: string;
  durationMs: number;
  dbCalls: number;
}

/**
 * Evaluates a policy's `allow` clause against `{ input, actor }` (SPEC-DECLARATIONS §5.2). The caller
 * is responsible for the 401 short-circuit: an anonymous actor never reaches this function in the
 * pipeline. Used by generated auth-matrix tests to compute the expected decision at test time.
 */
export async function evaluatePolicy(
  policy: PolicyDecl,
  env: { input: unknown; actor: Actor | null },
  options: ContractEvalOptions = {},
): Promise<PolicyEvaluation> {
  const meta = averriMeta(policy);
  const record = meta.contracts[0];
  const outcome = await evaluateContract(record, "requires", { input: env.input, actor: env.actor }, options);
  return {
    allow: outcome.ok,
    contract: record.id,
    tier: record.tier,
    evaluated: outcome.record.evaluated ?? {},
    undefinedRefs: outcome.record.undefinedRefs ?? [],
    message: outcome.message,
    durationMs: outcome.record.durationMs,
    dbCalls: outcome.dbCalls,
  };
}
