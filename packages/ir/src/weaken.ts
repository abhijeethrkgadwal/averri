/**
 * Weakening rule (SPEC-CONTRACTS §7): syntactic comparison of two clause ASTs with the same id.
 * Returns how the set of satisfying states changed; "admits more" is weakening for every phase.
 * Pure; no IO.
 */

import type { BoolExpr, ContractTier, DbWhere, DbWhereValue, Operand } from "./types.js";
import { canonicalJson, isLit, isRef } from "./ast.js";

/** Relation between the states satisfying `before` and those satisfying `after`. */
export type ClauseRelation = "equal" | "admits-more" | "admits-fewer" | "undecided";

/** Result mapped onto diff ops. */
export type ContractChangeKind = "weaken-contract" | "strengthen-contract" | "change" | "equal";

function flip(r: ClauseRelation): ClauseRelation {
  return r === "admits-more" ? "admits-fewer" : r === "admits-fewer" ? "admits-more" : r;
}

/** Combine relations of independent sub-edits: all agree (or equal) -> that direction; otherwise undecided. */
function combine(relations: readonly ClauseRelation[]): ClauseRelation {
  let acc: ClauseRelation = "equal";
  for (const r of relations) {
    if (r === "undecided") return "undecided";
    if (r === "equal") continue;
    if (acc === "equal") acc = r;
    else if (acc !== r) return "undecided";
  }
  return acc;
}

/**
 * Compare two boolean ASTs. `admits-more` means `after` is satisfied by a superset of the states that
 * satisfy `before`. Only the edits in the SPEC-CONTRACTS §7 table are decided; everything else is
 * `undecided`.
 */
export function compareClauses(before: BoolExpr, after: BoolExpr): ClauseRelation {
  const cb = canonicalJson(before);
  const ca = canonicalJson(after);
  if (cb === ca) return "equal";
  if (isCmpOp(before.op) && isCmpOp(after.op)) return compareComparison(before as Cmp, after as Cmp);
  if (before.op !== after.op) return "undecided";
  switch (before.op) {
    case "and":
    case "or":
      return compareArgLists(before.op, before.args, (after as typeof before).args);
    case "not":
      return flip(compareClauses(before.arg, (after as typeof before).arg));
    case "in": {
      const a = after as typeof before;
      if (canonicalJson(before.lhs) !== canonicalJson(a.lhs)) return "undecided";
      if (!isLit(before.rhs) || !isLit(a.rhs) || !Array.isArray(before.rhs.lit) || !Array.isArray(a.rhs.lit)) return "undecided";
      return compareSets(before.rhs.lit, a.rhs.lit);
    }
    case "emitted": {
      const a = after as typeof before;
      if (before.event !== a.event) return "undecided";
      const [bMin, bMax] = emittedRange(before.count);
      const [aMin, aMax] = emittedRange(a.count);
      if (aMin <= bMin && aMax >= bMax) return "admits-more";
      if (aMin >= bMin && aMax <= bMax) return "admits-fewer";
      return "undecided";
    }
    case "db.exists":
    case "db.unique": {
      const a = after as typeof before;
      if (before.model !== a.model) return "undecided";
      return whereToRows(compareWhere(before.where, a.where));
    }
    case "db.none": {
      const a = after as typeof before;
      if (before.model !== a.model) return "undecided";
      return flip(whereToRows(compareWhere(before.where, a.where)));
    }
    case "isNull":
    case "exists":
    default:
      return "undecided";
  }
}

/** Map the diff op for a Contract whose tier/AST changed between base and head. */
export function classifyContractChange(
  before: { tier: ContractTier; expr: BoolExpr | null },
  after: { tier: ContractTier; expr: BoolExpr | null },
): ContractChangeKind {
  if (before.tier === "guard" && after.tier === "guard") return "equal";
  // Replacing an analysable clause with a guard is weakening; the reverse is undecided (the guard was opaque).
  if (before.tier !== "guard" && after.tier === "guard") return "weaken-contract";
  if (before.tier === "guard" && after.tier !== "guard") return "change";
  if (!before.expr || !after.expr) return "change";
  const rel = compareClauses(before.expr, after.expr);
  return rel === "equal" ? "equal" : rel === "admits-more" ? "weaken-contract" : rel === "admits-fewer" ? "strengthen-contract" : "change";
}

// --- helpers ----------------------------------------------------------------------

const CMP_OPS: ReadonlySet<string> = new Set(["lt", "lte", "gt", "gte", "eq", "ne"]);
function isCmpOp(op: string): boolean {
  return CMP_OPS.has(op);
}

/**
 * Multiset comparison of `and`/`or` argument lists. Dropping a conjunct admits more, dropping a
 * disjunct admits fewer; a single edited argument recurses with unchanged polarity.
 */
function compareArgLists(op: "and" | "or", before: readonly BoolExpr[], after: readonly BoolExpr[]): ClauseRelation {
  const bKeys = before.map((x) => canonicalJson(x));
  const aKeys = after.map((x) => canonicalJson(x));
  const onlyBefore: number[] = [];
  const remainingAfter = new Map<string, number>();
  for (const k of aKeys) remainingAfter.set(k, (remainingAfter.get(k) ?? 0) + 1);
  bKeys.forEach((k, i) => {
    const n = remainingAfter.get(k) ?? 0;
    if (n > 0) remainingAfter.set(k, n - 1);
    else onlyBefore.push(i);
  });
  const onlyAfter: number[] = [];
  const remainingBefore = new Map<string, number>();
  for (const k of bKeys) remainingBefore.set(k, (remainingBefore.get(k) ?? 0) + 1);
  aKeys.forEach((k, i) => {
    const n = remainingBefore.get(k) ?? 0;
    if (n > 0) remainingBefore.set(k, n - 1);
    else onlyAfter.push(i);
  });
  if (onlyBefore.length === 0 && onlyAfter.length === 0) return "equal";
  const dropped: ClauseRelation = op === "and" ? "admits-more" : "admits-fewer";
  if (onlyAfter.length === 0) return dropped;
  if (onlyBefore.length === 0) return flip(dropped);
  if (onlyBefore.length === 1 && onlyAfter.length === 1) {
    return compareClauses(before[onlyBefore[0]!]!, after[onlyAfter[0]!]!);
  }
  return "undecided";
}

type Cmp = Extract<BoolExpr, { op: "lt" | "lte" | "gt" | "gte" | "eq" | "ne" }>;

function numericLit(o: Operand): number | null {
  return isLit(o) && typeof o.lit === "number" ? o.lit : null;
}

function compareComparison(before: Cmp, after: Cmp): ClauseRelation {
  if (before.op === "eq" || before.op === "ne" || after.op === "eq" || after.op === "ne") return "undecided";
  const sameLhs = canonicalJson(before.lhs) === canonicalJson(after.lhs);
  if (!sameLhs) return "undecided";
  const n = numericLit(before.rhs);
  const m = numericLit(after.rhs);
  if (n === null || m === null) return "undecided";
  // db.countWhere on the left: a looser where raises the count; the bound's effect depends on direction.
  if (isCountWhere(before.lhs)) return "undecided";
  return compareBounds(before.op, n, after.op, m);
}

function isCountWhere(o: Operand): boolean {
  return typeof o === "object" && o !== null && "op" in o && o.op === "db.countWhere";
}

/** Relation of `x <op2> m` to `x <op1> n` for upper (`lt`/`lte`) and lower (`gt`/`gte`) bounds. */
function compareBounds(op1: "lt" | "lte" | "gt" | "gte", n: number, op2: "lt" | "lte" | "gt" | "gte", m: number): ClauseRelation {
  const upper1 = op1 === "lt" || op1 === "lte";
  const upper2 = op2 === "lt" || op2 === "lte";
  if (upper1 !== upper2) return "undecided";
  const inclusive1 = op1 === "lte" || op1 === "gte";
  const inclusive2 = op2 === "lte" || op2 === "gte";
  if (upper1) {
    if (m > n || (m === n && inclusive2 && !inclusive1)) return "admits-more";
    if (m < n || (m === n && !inclusive2 && inclusive1)) return "admits-fewer";
    return "equal";
  }
  if (m < n || (m === n && inclusive2 && !inclusive1)) return "admits-more";
  if (m > n || (m === n && !inclusive2 && inclusive1)) return "admits-fewer";
  return "equal";
}

function compareSets(before: readonly unknown[], after: readonly unknown[]): ClauseRelation {
  const b = new Set(before.map((x) => canonicalJson(x)));
  const a = new Set(after.map((x) => canonicalJson(x)));
  const bInA = [...b].every((x) => a.has(x));
  const aInB = [...a].every((x) => b.has(x));
  if (bInA && aInB) return "equal";
  if (bInA) return "admits-more";
  if (aInB) return "admits-fewer";
  return "undecided";
}

function emittedRange(count: number | { min?: number; max?: number } | undefined): [number, number] {
  if (count === undefined) return [1, Number.POSITIVE_INFINITY];
  if (typeof count === "number") return [count, count];
  return [count.min ?? 0, count.max ?? Number.POSITIVE_INFINITY];
}

/** Relation between the ROW SETS matched by two where clauses: "looser" matches more rows. */
export type WhereRelation = "equal" | "looser" | "tighter" | "undecided";

export function compareWhere(before: DbWhere, after: DbWhere): WhereRelation {
  const relations: ClauseRelation[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (b === undefined && a !== undefined) relations.push("admits-fewer"); // key added: tighter
    else if (b !== undefined && a === undefined) relations.push("admits-more"); // key removed: looser
    else if (b !== undefined && a !== undefined) relations.push(compareWhereValue(b, a));
  }
  const r = combine(relations);
  return r === "admits-more" ? "looser" : r === "admits-fewer" ? "tighter" : r;
}

function compareWhereValue(before: DbWhereValue, after: DbWhereValue): ClauseRelation {
  if (canonicalJson(before) === canonicalJson(after)) return "equal";
  if (isRef(before) || isRef(after) || isLit(before) || isLit(after)) return "undecided";
  if ("in" in before && "in" in after) {
    if (!isLit(before.in) || !isLit(after.in) || !Array.isArray(before.in.lit) || !Array.isArray(after.in.lit)) return "undecided";
    return compareSets(before.in.lit, after.in.lit);
  }
  const bOp = boundOf(before);
  const aOp = boundOf(after);
  if (bOp && aOp) return compareBounds(bOp.op, bOp.value, aOp.op, aOp.value);
  return "undecided";
}

function boundOf(v: DbWhereValue): { op: "lt" | "lte" | "gt" | "gte"; value: number } | null {
  for (const op of ["lt", "lte", "gt", "gte"] as const) {
    if (op in v) {
      const operand = (v as Record<string, unknown>)[op];
      const n = isLit(operand) && typeof operand.lit === "number" ? operand.lit : null;
      return n === null ? null : { op, value: n };
    }
  }
  return null;
}

/** `db.exists`/`db.unique`/`db.countWhere`: more rows -> admits more (SPEC-CONTRACTS §7 table). */
function whereToRows(r: WhereRelation): ClauseRelation {
  return r === "looser" ? "admits-more" : r === "tighter" ? "admits-fewer" : r;
}
