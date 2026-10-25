/**
 * A tiny, independent evaluator for tier-1 clauses over `{ input, self }` values, used to check that
 * the generated arbitraries really satisfy / violate the clauses they were derived from.
 */

import type { BoolExpr, Operand } from "@averri/ir";
import * as fc from "fast-check";

export type Env = { input?: Record<string, unknown>; self?: Record<string, unknown> };

function value(op: Operand, env: Env): unknown {
  if ("ref" in op) {
    const [root, ...segs] = op.ref.split(".");
    let cur: unknown = (env as Record<string, unknown>)[root as string];
    for (const s of segs) cur = cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[s] : undefined;
    return cur;
  }
  if ("lit" in op) return op.lit;
  if (op.op === "len") {
    const v = value(op.arg, env);
    return typeof v === "string" || Array.isArray(v) ? v.length : undefined;
  }
  throw new Error(`mini-eval: unsupported operand ${op.op}`);
}

function norm(v: unknown): unknown {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) return Date.parse(v);
  if (v instanceof Date) return v.getTime();
  return v;
}

export function evalClause(expr: BoolExpr, env: Env): boolean {
  switch (expr.op) {
    case "eq":
      return norm(value(expr.lhs, env)) === norm(value(expr.rhs, env));
    case "ne":
      return norm(value(expr.lhs, env)) !== norm(value(expr.rhs, env));
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const a = norm(value(expr.lhs, env));
      const b = norm(value(expr.rhs, env));
      if (typeof a !== "number" || typeof b !== "number") return false;
      return expr.op === "lt" ? a < b : expr.op === "lte" ? a <= b : expr.op === "gt" ? a > b : a >= b;
    }
    case "in": {
      const v = value(expr.lhs, env);
      const list = value(expr.rhs, env);
      return Array.isArray(list) && list.includes(v);
    }
    case "isNull": {
      const v = value(expr.arg, env);
      return v === null || v === undefined;
    }
    case "and":
      return expr.args.every((a) => evalClause(a, env));
    case "or":
      return expr.args.some((a) => evalClause(a, env));
    case "not":
      return !evalClause(expr.arg, env);
    default:
      throw new Error(`mini-eval: unsupported clause ${expr.op}`);
  }
}

let counter = 0;
export const runtime = {
  fc,
  nonce: () => `n${(counter += 1).toString(36)}`,
  nonceInt: () => (counter += 1),
};

/** Instantiate an emitted arbitrary source with real fast-check. */
export function instantiate<T = unknown>(src: string): fc.Arbitrary<T> {
  const factory = new Function("fc", "nonce", "nonceInt", `return (${src});`) as (f: typeof fc, n: () => string, ni: () => number) => fc.Arbitrary<T>;
  return factory(fc, runtime.nonce, runtime.nonceInt);
}
