/**
 * The `db.*` predicate compiler (SPEC-CONTRACTS §5): un-flattens the canonical flat `where` into
 * Prisma's nested form while substituting refs, applies the fail-closed undefined-ref rule, and runs
 * one `count` per predicate.
 */
import type { BoolExpr, ContractExpr, DbCountWhere, DbPredicate, DbWhere, DbWhereOperand, Operand, RefPath } from "@averri/ir";
import { AverriRuntimeError, errorMessage } from "./errors.js";
import { evalWhereOperand, resolveRef } from "./refs.js";
import type { DbResult, EvalEnv, PrismaLike, PrismaModelLike, Row } from "./types.js";

export type DbNode = DbPredicate | DbCountWhere;
export type PrismaWhere = Record<string, unknown>;

export interface CompiledWhere {
  where: PrismaWhere;
  /** Every ref (in a key value or an operator operand) that resolved to `undefined`. */
  undefinedRefs: RefPath[];
}

/** `{ "user.email": v1, teamId: v2 }` becomes `{ user: { email: v1 }, teamId: v2 }`. Later keys merge into earlier objects. */
export function unflattenWhere(flat: Record<string, unknown>): PrismaWhere {
  const out: PrismaWhere = {};
  for (const key of Object.keys(flat)) {
    const segments = key.split(".");
    let target: Row = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i] as string;
      const existing = target[segment];
      if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        target = existing as Row;
      } else {
        const next: Row = {};
        target[segment] = next;
        target = next;
      }
    }
    target[segments[segments.length - 1] as string] = flat[key];
  }
  return out;
}

/**
 * Substitutes refs and lowers operator forms (`{in}`, `{not}`, `{lt}`, ...) to Prisma filters.
 * `{ in: ref }` whose ref is not a list counts as an undefined ref (fail closed).
 */
export function compileWhere(where: DbWhere, env: EvalEnv): CompiledWhere {
  const undefinedRefs: RefPath[] = [];
  const note = (ref: RefPath | null): void => {
    if (ref !== null && !undefinedRefs.includes(ref)) undefinedRefs.push(ref);
  };
  const flat: Record<string, unknown> = {};
  for (const key of Object.keys(where)) {
    const value = where[key];
    if (value === undefined) continue;
    if ("ref" in value) {
      const v = resolveRef(value.ref, env);
      if (v === undefined) note(value.ref);
      flat[key] = v;
      continue;
    }
    if ("lit" in value) {
      flat[key] = value.lit;
      continue;
    }
    if ("in" in value) {
      const operand = value.in;
      if ("lit" in operand) {
        flat[key] = { in: Array.isArray(operand.lit) ? [...operand.lit] : [operand.lit] };
      } else {
        const list = resolveRef(operand.ref, env);
        if (!Array.isArray(list)) note(operand.ref);
        flat[key] = { in: Array.isArray(list) ? list : undefined };
      }
      continue;
    }
    const operator = (["not", "lt", "lte", "gt", "gte"] as const).find((op) => op in value);
    if (operator === undefined) continue;
    const operand = (value as unknown as Record<string, DbWhereOperand>)[operator] as DbWhereOperand;
    const { value: v, undefinedRef } = evalWhereOperand(operand, env);
    note(undefinedRef);
    flat[key] = { [operator]: v };
  }
  return { where: unflattenWhere(flat), undefinedRefs };
}

/** Returns the model accessor or throws `unknown-model`. */
export function modelOf(prisma: PrismaLike, model: string): PrismaModelLike {
  const accessor = (prisma as Record<string, unknown>)[model];
  if (typeof accessor !== "object" || accessor === null || typeof (accessor as { count?: unknown }).count !== "function") {
    throw new AverriRuntimeError("unknown-model", `Prisma client has no model accessor "${model}" with a count() method (A1003)`);
  }
  return accessor as PrismaModelLike;
}

export async function countRows(prisma: PrismaLike, model: string, where: PrismaWhere): Promise<number> {
  const n = await modelOf(prisma, model).count({ where });
  if (typeof n !== "number") throw new AverriRuntimeError("unknown-model", `prisma.${model}.count() returned ${typeof n}, expected a number`);
  return n;
}

/**
 * Evaluates one `db.*` node: compiles the where, applies the fail-closed rule (no call when any ref
 * is undefined) and otherwise performs exactly one `count`.
 */
export async function evaluateDbNode(node: DbNode, env: EvalEnv, prisma: PrismaLike | null | undefined): Promise<DbResult> {
  const compiled = compileWhere(node.where, env);
  if (compiled.undefinedRefs.length > 0) {
    return { count: null, undefinedRefs: compiled.undefinedRefs, where: compiled.where, skipped: true };
  }
  if (prisma === null || prisma === undefined) {
    throw new AverriRuntimeError("no-prisma", `${node.op}("${node.model}") needs a Prisma client`);
  }
  const count = await countRows(prisma, node.model, compiled.where);
  return { count, undefinedRefs: [], where: compiled.where, skipped: false };
}

/** The truth value of a predicate given its count (SPEC-CONTRACTS §5 table). */
export function predicateHolds(op: DbPredicate["op"], count: number): boolean {
  switch (op) {
    case "db.exists":
      return count > 0;
    case "db.none":
      return count === 0;
    case "db.unique":
      return count === 1;
  }
}

/** Every `db.*` node of an AST in evaluation order (depth-first, left to right). */
export function collectDbNodes(root: ContractExpr): DbNode[] {
  const out: DbNode[] = [];
  const go = (node: ContractExpr): void => {
    if (!("op" in node)) return;
    switch (node.op) {
      case "db.exists":
      case "db.none":
      case "db.unique":
      case "db.countWhere":
        out.push(node);
        return;
      case "eq":
      case "ne":
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        go(node.lhs);
        go(node.rhs);
        return;
      case "in":
        go(node.lhs);
        return;
      case "and":
      case "or":
        node.args.forEach(go);
        return;
      case "not":
        go(node.arg);
        return;
      case "count":
      case "exists":
        if (node.where) go(node.where);
        return;
      default:
        return;
    }
  };
  go(root);
  return out;
}

export interface PrefetchedDb {
  results: Map<DbNode, DbResult>;
  /** Prisma calls actually made. */
  dbCalls: number;
  /** Messages of nodes whose evaluation threw (recorded as a failed, fail-closed predicate). */
  errors: string[];
}

/**
 * Evaluates every `db.*` node of an expression against the client up front, so the synchronous
 * evaluator can look results up by node identity. A node whose Prisma call throws is recorded with
 * `count: null` (fail closed) and the message is returned in `errors`.
 */
export async function prefetchDbNodes(expr: BoolExpr | Operand, env: EvalEnv, prisma: PrismaLike | null | undefined): Promise<PrefetchedDb> {
  const results = new Map<DbNode, DbResult>();
  const errors: string[] = [];
  let dbCalls = 0;
  for (const node of collectDbNodes(expr)) {
    if (results.has(node)) continue;
    try {
      const result = await evaluateDbNode(node, env, prisma);
      if (!result.skipped) dbCalls += 1;
      results.set(node, result);
    } catch (error) {
      errors.push(`${node.op}("${node.model}"): ${errorMessage(error)}`);
      results.set(node, { count: null, undefinedRefs: [], where: compileWhere(node.where, env).where, skipped: true });
    }
  }
  return { results, dbCalls, errors };
}
