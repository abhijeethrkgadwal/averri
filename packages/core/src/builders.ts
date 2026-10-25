/**
 * The `e.*` expression builder and the `db.*` predicate builder (SPEC-CONTRACTS §4–5).
 *
 * Both produce the serializable contract AST from @averri/ir, frozen, with the canonical key order of
 * each node (`{ op, lhs, rhs }`, `{ op, args }`, `{ op, arg }`, `{ op, path, where? }`, `{ op, path, field }`,
 * `{ op, event, count? }`, `{ op, model, where }`). Optional keys are omitted when absent. Bare paths are
 * root-qualified and nested `where` objects are flattened here, so the runtime value, the IR and the test
 * generator share one representation (D-3). No lambda is ever inspected; no import-time side effects.
 */
import type { BoolExpr, CompareOp, CountExpr, DbPredicate, DbWhere, EmittedExpr, EventId, ExistsExpr, Lit, Ref } from "@averri/ir";
import type { AnalysableClause, DbPredicateBuilder, DbValue, EventDecl, ExprClause, ExpressionBuilder, PredicateClause } from "./types.js";
import {
  clauseOf,
  isAnalysableClause,
  isGuard,
  isValueOperand,
  lowerLhs,
  lowerLit,
  lowerLitList,
  lowerRhs,
  refValueOf,
  rootedRef,
  scalarValueOf,
  toRef,
  valueOf,
  describeOperand,
  flattenWhere,
} from "./ast.js";
import { AverriDeclarationError, describe, isPlainObject } from "./errors.js";

function compare(op: CompareOp, lhs: unknown, rhs: unknown): AnalysableClause {
  const construct = `e.${op}`;
  return clauseOf(Object.freeze({ op, lhs: lowerLhs(construct, lhs), rhs: lowerRhs(construct, rhs) }));
}

function requireClauses(construct: string, clauses: readonly unknown[]): BoolExpr[] {
  if (clauses.length === 0) {
    throw new AverriDeclarationError(construct, null, null, "expected at least one clause");
  }
  return clauses.map((clause, index) => {
    if (isGuard(clause)) {
      throw new AverriDeclarationError(
        construct,
        null,
        `args[${index}]`,
        "a guard (bare function) cannot be combined with e.and/e.or/e.not; write it as its own clause",
      );
    }
    if (!isAnalysableClause(clause)) {
      throw new AverriDeclarationError(
        construct,
        null,
        `args[${index}]`,
        `expected a clause built with e.* or db.*, got ${describeOperand(clause)}`,
      );
    }
    return clause.ast;
  });
}

/** `where` of `e.exists`/`e.count`: an expression-tier clause whose bare paths refer to the element. */
function elementWhere(construct: string, where: unknown): BoolExpr | undefined {
  if (where === undefined) return undefined;
  if (isGuard(where)) {
    throw new AverriDeclarationError(construct, null, "where", "a guard (bare function) cannot be used as an element filter");
  }
  if (!isAnalysableClause(where)) {
    throw new AverriDeclarationError(construct, null, "where", `expected a clause built with e.*, got ${describeOperand(where)}`);
  }
  if (where.tier !== "expr") {
    throw new AverriDeclarationError(construct, null, "where", "an element filter must be expression-tier (no db.* inside; A3009)");
  }
  return where.ast;
}

function lowerCount(construct: string, count: unknown): EmittedExpr["count"] | undefined {
  if (count === undefined) return undefined;
  if (typeof count === "number") {
    if (!Number.isInteger(count) || count < 0) {
      throw new AverriDeclarationError(construct, null, "count", `expected a non-negative integer, got ${describe(count)}`);
    }
    return count;
  }
  if (!isPlainObject(count)) {
    throw new AverriDeclarationError(construct, null, "count", `expected a number or { min?, max? }, got ${describe(count)}`);
  }
  const extra = Object.keys(count).filter((key) => key !== "min" && key !== "max");
  if (extra.length > 0) {
    throw new AverriDeclarationError(construct, null, "count", `unknown keys ${JSON.stringify(extra)} (allowed: min, max)`);
  }
  const range: { min?: number; max?: number } = {};
  for (const key of ["min", "max"] as const) {
    const value = count[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new AverriDeclarationError(construct, null, `count.${key}`, `expected a non-negative integer, got ${describe(value)}`);
    }
    range[key] = value;
  }
  if (range.min === undefined && range.max === undefined) {
    throw new AverriDeclarationError(construct, null, "count", "expected at least one of min, max");
  }
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
    throw new AverriDeclarationError(construct, null, "count", `min (${range.min}) is greater than max (${range.max})`);
  }
  return Object.freeze(range);
}

export function isEventDecl(value: unknown): value is EventDecl {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "event" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function withOptional<T extends object>(node: T, key: string, value: unknown): T {
  return Object.freeze(value === undefined ? node : { ...node, [key]: value }) as T;
}

/** The expression builder. Frozen; every method is pure. */
const expressionBuilder: ExpressionBuilder = {
  input: (field) => refValueOf(rootedRef("e.input", "input", field)),
  actor: (field) => refValueOf(rootedRef("e.actor", "actor", field)),
  self: (field) => refValueOf(rootedRef("e.self", "self", field)),
  old: (field) => refValueOf(rootedRef("e.old", "old", field)),
  result: (field) => refValueOf(rootedRef("e.result", "result", field)),
  lit: (value) => scalarValueOf(lowerLit("e.lit", null, value)),

  eq: ((lhs: unknown, rhs: unknown) => compare("eq", lhs, rhs)) as ExpressionBuilder["eq"],
  ne: ((lhs: unknown, rhs: unknown) => compare("ne", lhs, rhs)) as ExpressionBuilder["ne"],
  lt: ((lhs: unknown, rhs: unknown) => compare("lt", lhs, rhs)) as ExpressionBuilder["lt"],
  lte: ((lhs: unknown, rhs: unknown) => compare("lte", lhs, rhs)) as ExpressionBuilder["lte"],
  gt: ((lhs: unknown, rhs: unknown) => compare("gt", lhs, rhs)) as ExpressionBuilder["gt"],
  gte: ((lhs: unknown, rhs: unknown) => compare("gte", lhs, rhs)) as ExpressionBuilder["gte"],

  and: ((...clauses: unknown[]) =>
    clauseOf(Object.freeze({ op: "and" as const, args: Object.freeze(requireClauses("e.and", clauses)) as BoolExpr[] }))) as ExpressionBuilder["and"],
  or: ((...clauses: unknown[]) =>
    clauseOf(Object.freeze({ op: "or" as const, args: Object.freeze(requireClauses("e.or", clauses)) as BoolExpr[] }))) as ExpressionBuilder["or"],
  not: ((clause: unknown) =>
    clauseOf(Object.freeze({ op: "not" as const, arg: requireClauses("e.not", [clause])[0] as BoolExpr }))) as ExpressionBuilder["not"],

  in: ((lhs: unknown, list: unknown) => {
    let rhs: Ref | Lit;
    if (isValueOperand(list)) {
      if (!("ref" in list.ast)) {
        throw new AverriDeclarationError("e.in", null, "list", `expected a literal list or a reference to a list field, got ${describeOperand(list)}`);
      }
      rhs = list.ast as Ref;
    } else {
      rhs = lowerLitList("e.in", "list", list);
    }
    return clauseOf(Object.freeze({ op: "in" as const, lhs: lowerLhs("e.in", lhs), rhs }));
  }) as ExpressionBuilder["in"],
  isNull: (path) => clauseOf(Object.freeze({ op: "isNull" as const, arg: toRef("e.isNull", "path", path) })) as ExprClause,

  len: (path) => scalarValueOf(Object.freeze({ op: "len" as const, arg: toRef("e.len", "path", path) })),
  sum: (path, field) => {
    if (typeof field !== "string" || field.length === 0) {
      throw new AverriDeclarationError("e.sum", null, "field", `expected a field name, got ${describe(field)}`);
    }
    return valueOf(Object.freeze({ op: "sum" as const, path: toRef("e.sum", "path", path), field }));
  },
  count: (path, where) =>
    valueOf(withOptional<CountExpr>({ op: "count", path: toRef("e.count", "path", path) }, "where", elementWhere("e.count", where))),
  exists: (path, where) =>
    clauseOf(withOptional<ExistsExpr>({ op: "exists", path: toRef("e.exists", "path", path) }, "where", elementWhere("e.exists", where))) as ExprClause,

  emitted: (event, count) => {
    if (!isEventDecl(event)) {
      throw new AverriDeclarationError("e.emitted", null, "event", `expected an event() declaration, got ${describe(event)}`);
    }
    return clauseOf(withOptional<EmittedExpr>({ op: "emitted", event: event.id as EventId }, "count", lowerCount("e.emitted", count))) as ExprClause;
  },
};
export const e: ExpressionBuilder = Object.freeze(expressionBuilder);

function requireModel(construct: string, model: unknown): string {
  if (typeof model !== "string" || model.length === 0) {
    throw new AverriDeclarationError(construct, null, "model", `expected a Prisma client accessor name (e.g. "membership"), got ${describe(model)}`);
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(model)) {
    throw new AverriDeclarationError(construct, null, "model", `${JSON.stringify(model)} is not an identifier`);
  }
  return model;
}

function predicate(op: "db.exists" | "db.none" | "db.unique", model: unknown, where: unknown): PredicateClause {
  const node = Object.freeze({ op, model: requireModel(op, model), where: flattenWhere(op, "where", where) as DbWhere });
  return Object.freeze({ tier: "predicate" as const, ast: node as DbPredicate });
}

/** The predicate builder. Frozen; every method is pure. */
const predicateBuilder: DbPredicateBuilder = {
  exists: (model, where) => predicate("db.exists", model, where),
  none: (model, where) => predicate("db.none", model, where),
  unique: (model, where) => predicate("db.unique", model, where),
  countWhere: (model, where): DbValue =>
    Object.freeze({
      tier: "dbvalue" as const,
      ast: Object.freeze({
        op: "db.countWhere" as const,
        model: requireModel("db.countWhere", model),
        where: flattenWhere("db.countWhere", "where", where) as DbWhere,
      }),
    }),
};
export const db: DbPredicateBuilder = Object.freeze(predicateBuilder);
