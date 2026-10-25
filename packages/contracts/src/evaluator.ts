/**
 * The tier-1 expression evaluator (SPEC-CONTRACTS §4) and, through pre-fetched `db.*` results, the
 * tier-2 evaluator. Pure over plain objects; `evaluateExpr` performs no I/O.
 *
 * - Evaluation is total: a missing field is `undefined`, comparisons with `undefined` are `false`.
 * - `evaluated` is keyed by the AST path of the comparison node (`""`, `args[1]`, `arg.args[0]`);
 *   for a failing `and` it holds the first failing conjunct's leaves, for `or` every leaf evaluated.
 * - `undefinedRefs` lists every ref that resolved to `undefined` (except under `isNull`, where it is meaningful).
 */
import type { BoolExpr, DbPredicate, EventId, Operand, RefPath } from "@averri/ir";
import { AverriRuntimeError } from "./errors.js";
import { collectDbNodes, predicateHolds, prefetchDbNodes, type DbNode } from "./predicates.js";
import { resolveRef } from "./refs.js";
import type { DbResult, EvalEnv, EvalResult, EvaluatedEntry, PrismaLike, Row } from "./types.js";
import { compareValues, lengthOf, normaliseValue, toJsonValue, valuesEqual } from "./values.js";

interface Ctx {
  env: EvalEnv;
  db: ReadonlyMap<DbNode, DbResult> | null;
  evaluated: Record<string, EvaluatedEntry>;
  undefinedRefs: RefPath[];
  /** True inside an `exists`/`count` element filter: leaves are not recorded (they repeat per element). */
  elementScope: boolean;
  /**
   * Shared across element scopes. `value` is set when an evaluated `db.*` node had no usable count
   * (undefined ref or Prisma error), or when a ref resolved to `undefined` underneath a `not`
   * (`negated` > 0). A poisoned clause is false as a whole, so `not(...)` cannot flip a fail-closed
   * comparison or predicate into a pass (SPEC-DECISIONS D-41a).
   */
  poison: { value: boolean; negated: number };
}

function join(path: string, segment: string): string {
  return path === "" ? segment : `${path}.${segment}`;
}

function noteUndefined(ctx: Ctx, ref: RefPath): void {
  if (!ctx.undefinedRefs.includes(ref)) ctx.undefinedRefs.push(ref);
  if (ctx.poison.negated > 0) ctx.poison.value = true;
}

function record(ctx: Ctx, path: string, lhs: unknown, rhs: unknown): void {
  if (ctx.elementScope) return;
  ctx.evaluated[path] = { lhs: toJsonValue(lhs) ?? null, rhs: toJsonValue(rhs) ?? null };
}

function resolve(ctx: Ctx, ref: RefPath): unknown {
  const value = resolveRef(ref, ctx.env);
  if (value === undefined) noteUndefined(ctx, ref);
  return value;
}

function dbResult(ctx: Ctx, node: DbNode): DbResult {
  const result = ctx.db?.get(node);
  if (result === undefined) {
    throw new AverriRuntimeError("db-op-in-sync-eval", `${node.op}("${node.model}") needs a database: use evaluateClause() with a Prisma client`);
  }
  return result;
}

function expectedOf(op: DbPredicate["op"]): string {
  return op === "db.exists" ? "count > 0" : op === "db.none" ? "count == 0" : "count == 1";
}

function evalElements(ctx: Ctx, path: string, list: unknown[], where: BoolExpr | undefined): number {
  if (where === undefined) return list.length;
  let n = 0;
  for (const element of list) {
    const elementCtx: Ctx = {
      env: { ...ctx.env, self: (typeof element === "object" && element !== null ? element : null) as Row | null },
      db: ctx.db,
      evaluated: {},
      undefinedRefs: ctx.undefinedRefs,
      elementScope: true,
      poison: ctx.poison,
    };
    if (evalBool(where, join(path, "where"), elementCtx)) n += 1;
  }
  return n;
}

function evalOperand(node: Operand, path: string, ctx: Ctx): unknown {
  if ("ref" in node) return resolve(ctx, node.ref);
  if ("lit" in node) return node.lit;
  switch (node.op) {
    case "len":
      return lengthOf(resolve(ctx, node.arg.ref));
    case "sum": {
      const list = resolve(ctx, node.path.ref);
      if (!Array.isArray(list)) return undefined;
      let total = 0;
      for (const element of list) {
        const raw = typeof element === "object" && element !== null ? (element as Row)[node.field] : undefined;
        const n = normaliseValue(raw);
        if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
        total += n;
      }
      return total;
    }
    case "count": {
      const list = resolve(ctx, node.path.ref);
      if (!Array.isArray(list)) return undefined;
      return evalElements(ctx, path, list, node.where);
    }
    case "db.countWhere": {
      const result = dbResult(ctx, node);
      for (const ref of result.undefinedRefs) noteUndefined(ctx, ref);
      if (result.count === null) {
        ctx.poison.value = true;
        return undefined;
      }
      return result.count;
    }
  }
}

function emittedMatches(count: number, expected: number | { min?: number; max?: number } | undefined): boolean {
  if (expected === undefined) return count >= 1;
  if (typeof expected === "number") return count === expected;
  if (expected.min !== undefined && count < expected.min) return false;
  if (expected.max !== undefined && count > expected.max) return false;
  return true;
}

function evalBool(node: BoolExpr, path: string, ctx: Ctx): boolean {
  switch (node.op) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const lhs = evalOperand(node.lhs, join(path, "lhs"), ctx);
      const rhs = evalOperand(node.rhs, join(path, "rhs"), ctx);
      record(ctx, path, lhs, rhs);
      return compareValues(node.op, lhs, rhs);
    }
    case "and": {
      const before = ctx.evaluated;
      const passed: Record<string, EvaluatedEntry> = {};
      for (let i = 0; i < node.args.length; i++) {
        ctx.evaluated = {};
        const ok = evalBool(node.args[i] as BoolExpr, join(path, `args[${i}]`), ctx);
        if (!ok) {
          ctx.evaluated = { ...before, ...ctx.evaluated };
          return false;
        }
        Object.assign(passed, ctx.evaluated);
      }
      ctx.evaluated = { ...before, ...passed };
      return true;
    }
    case "or": {
      for (let i = 0; i < node.args.length; i++) {
        if (evalBool(node.args[i] as BoolExpr, join(path, `args[${i}]`), ctx)) return true;
      }
      return false;
    }
    case "not": {
      ctx.poison.negated += 1;
      try {
        return !evalBool(node.arg, join(path, "arg"), ctx);
      } finally {
        ctx.poison.negated -= 1;
      }
    }
    case "in": {
      const lhs = evalOperand(node.lhs, join(path, "lhs"), ctx);
      const list = "ref" in node.rhs ? resolve(ctx, node.rhs.ref) : node.rhs.lit;
      record(ctx, path, lhs, list);
      if (!Array.isArray(list)) return false;
      return list.some((candidate) => valuesEqual(lhs, candidate));
    }
    case "isNull": {
      const value = resolveRef(node.arg.ref, ctx.env);
      record(ctx, path, value, null);
      return value === null || value === undefined;
    }
    case "exists": {
      const list = resolve(ctx, node.path.ref);
      if (!Array.isArray(list)) {
        record(ctx, path, undefined, "count >= 1");
        return false;
      }
      const n = evalElements(ctx, path, list, node.where);
      record(ctx, path, n, "count >= 1");
      return n >= 1;
    }
    case "emitted": {
      const count = (ctx.env.emitted ?? []).filter((id: EventId) => id === node.event).length;
      record(ctx, path, count, node.count ?? { min: 1 });
      return emittedMatches(count, node.count);
    }
    case "db.exists":
    case "db.none":
    case "db.unique": {
      const result = dbResult(ctx, node);
      for (const ref of result.undefinedRefs) noteUndefined(ctx, ref);
      record(ctx, path, result.count, expectedOf(node.op));
      if (result.count === null) {
        ctx.poison.value = true;
        return false;
      }
      return predicateHolds(node.op, result.count);
    }
  }
}

/**
 * Synchronous evaluation of a boolean AST. `db.*` nodes are looked up in `dbResults` (see
 * {@link evaluateClause}); without them a predicate throws `db-op-in-sync-eval`.
 */
export function evaluateExpr(expr: BoolExpr, env: EvalEnv, dbResults: ReadonlyMap<DbNode, DbResult> | null = null): EvalResult {
  const ctx: Ctx = { env, db: dbResults, evaluated: {}, undefinedRefs: [], elementScope: false, poison: { value: false, negated: 0 } };
  const ok = evalBool(expr, "", ctx) && !ctx.poison.value;
  return { ok, evaluated: ctx.evaluated, undefinedRefs: ctx.undefinedRefs };
}

/** Synchronous evaluation of a value operand (`e.len`, `e.sum`, `e.count`, refs, literals). */
export function evaluateOperand(
  operand: Operand,
  env: EvalEnv,
  dbResults: ReadonlyMap<DbNode, DbResult> | null = null,
): { value: unknown; undefinedRefs: RefPath[] } {
  const ctx: Ctx = { env, db: dbResults, evaluated: {}, undefinedRefs: [], elementScope: false, poison: { value: false, negated: 0 } };
  const value = evalOperand(operand, "", ctx);
  return { value, undefinedRefs: ctx.undefinedRefs };
}

export interface ClauseResult extends EvalResult {
  /** Prisma `count` calls performed. */
  dbCalls: number;
  /** Prisma errors inside predicates. Any error makes the whole clause false (fail closed). */
  errors: string[];
}

/**
 * Evaluates a tier 1 or tier 2 clause: `db.*` nodes are evaluated first (one `count` each, skipped
 * under the undefined-ref rule), then the expression is evaluated synchronously.
 */
export async function evaluateClause(expr: BoolExpr, env: EvalEnv, prisma?: PrismaLike | null): Promise<ClauseResult> {
  if (collectDbNodes(expr).length === 0) return { ...evaluateExpr(expr, env), dbCalls: 0, errors: [] };
  const prefetched = await prefetchDbNodes(expr, env, prisma);
  const result = evaluateExpr(expr, env, prefetched.results);
  if (prefetched.errors.length > 0) result.ok = false;
  return { ...result, dbCalls: prefetched.dbCalls, errors: prefetched.errors };
}
