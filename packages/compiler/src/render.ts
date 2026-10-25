/**
 * Human renderings of contract ASTs for spec cards (SPEC-DECLARATIONS §7): `membership exists where
 * teamId = input.teamId, role in [owner, admin]`, `result.status = "pending"`, `MemberInvited emitted
 * exactly 1`.
 */

import { whereLeaves, type BoolExpr, type ContractExpr, type DbWhere, type Operand } from "@averri/ir";

function lit(v: unknown, quoteStrings: boolean): string {
  if (Array.isArray(v)) return `[${v.map((x) => lit(x, false)).join(", ")}]`;
  if (typeof v === "string") return quoteStrings ? JSON.stringify(v) : v;
  return String(v);
}

export function renderOperand(o: Operand | ContractExpr): string {
  const x = o as unknown as Record<string, unknown>;
  if (typeof x.ref === "string") return x.ref;
  if ("lit" in x) return lit(x.lit, true);
  switch (x.op) {
    case "len":
      return `length of ${(x.arg as { ref: string }).ref}`;
    case "sum":
      return `sum of ${(x.path as { ref: string }).ref}.${String(x.field)}`;
    case "count":
      return x.where ? `count of ${(x.path as { ref: string }).ref} where ${renderClause(x.where as BoolExpr)}` : `count of ${(x.path as { ref: string }).ref}`;
    case "db.countWhere":
      return `number of ${String(x.model)} where ${renderWhere(x.where as DbWhere)}`;
    default:
      return renderClause(o as BoolExpr);
  }
}

export function renderWhere(where: DbWhere): string {
  return whereLeaves(where)
    .map((l) => {
      const v = l.value as unknown as Record<string, unknown>;
      const val = typeof v.ref === "string" ? v.ref : "lit" in v ? lit(v.lit, l.operator !== "in") : renderOperand(l.value as Operand);
      switch (l.operator) {
        case null:
          return v.lit === null ? `${l.key} is null` : `${l.key} = ${val}`;
        case "in":
          return `${l.key} in ${val}`;
        case "not":
          return v.lit === null ? `${l.key} is not null` : `${l.key} != ${val}`;
        case "lt":
          return `${l.key} < ${val}`;
        case "lte":
          return `${l.key} <= ${val}`;
        case "gt":
          return `${l.key} > ${val}`;
        case "gte":
          return `${l.key} >= ${val}`;
      }
    })
    .join(", ");
}

const CMP: Record<string, string> = { eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };

function paren(e: BoolExpr): string {
  const s = renderClause(e);
  return e.op === "and" || e.op === "or" ? `(${s})` : s;
}

export function renderClause(e: BoolExpr): string {
  switch (e.op) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      if (e.op === "eq" && "lit" in e.rhs && e.rhs.lit === null) return `${renderOperand(e.lhs)} is null`;
      return `${renderOperand(e.lhs)} ${CMP[e.op]} ${renderOperand(e.rhs)}`;
    case "and":
      return e.args.map(paren).join(" and ");
    case "or":
      return e.args.map(paren).join(" or ");
    case "not":
      if (e.arg.op === "isNull") return `${e.arg.arg.ref} is set`;
      return `not ${paren(e.arg)}`;
    case "in":
      return `${renderOperand(e.lhs)} in ${"lit" in e.rhs ? lit(e.rhs.lit, false) : e.rhs.ref}`;
    case "isNull":
      return `${e.arg.ref} is null`;
    case "exists":
      return e.where ? `some ${e.path.ref} where ${renderClause(e.where)}` : `${e.path.ref} is not empty`;
    case "emitted": {
      const name = e.event.slice("Event:".length);
      const c = e.count;
      if (c === undefined) return `${name} emitted at least once`;
      if (typeof c === "number") return `${name} emitted exactly ${c}`;
      if (c.min !== undefined && c.max !== undefined) return `${name} emitted ${c.min}..${c.max} times`;
      return c.min !== undefined ? `${name} emitted at least ${c.min}` : `${name} emitted at most ${c.max}`;
    }
    case "db.exists":
      return `${e.model} exists where ${renderWhere(e.where)}`;
    case "db.none":
      return `no ${e.model} where ${renderWhere(e.where)}`;
    case "db.unique":
      return `exactly one ${e.model} where ${renderWhere(e.where)}`;
  }
}
