/**
 * Tier-1 clause analysis: turn a `BoolExpr` into per-field constraints that SATISFY it and per-field
 * constraints that VIOLATE exactly it (SPEC-CONTRACTS §10: negate the root comparison; `and` ->
 * violate one conjunct, `or` -> violate all; `not` flips). Only single-segment refs on `input` and
 * `self` compared with literals are analysable here; everything else is reported as a todo reason.
 */

import { isLit, isRef, refRoot, refSegments, type BoolExpr, type LitScalar, type Operand } from "@averri/ir";
import { isIsoDate } from "./arbitraries.js";

export type AnalysableRoot = "input" | "self";

export type Atom =
  | { root: AnalysableRoot; field: string; op: "eq" | "ne"; value: LitScalar }
  | { root: AnalysableRoot; field: string; op: "lt" | "lte" | "gt" | "gte"; value: number | string }
  | { root: AnalysableRoot; field: string; op: "in" | "notIn"; values: LitScalar[] }
  | { root: AnalysableRoot; field: string; op: "isNull" | "notNull" }
  | { root: AnalysableRoot; field: string; op: "lenLt" | "lenLte" | "lenGt" | "lenGte"; value: number };

export type Conjunction = Atom[];

export type ClauseAnalysis = { ok: true; satisfy: Conjunction; violate: Conjunction } | { ok: false; reason: string };

const FLIP: Record<Atom["op"], Atom["op"]> = {
  eq: "ne",
  ne: "eq",
  lt: "gte",
  lte: "gt",
  gt: "lte",
  gte: "lt",
  in: "notIn",
  notIn: "in",
  isNull: "notNull",
  notNull: "isNull",
  lenLt: "lenGte",
  lenLte: "lenGt",
  lenGt: "lenLte",
  lenGte: "lenLt",
};

const MIRROR: Record<"lt" | "lte" | "gt" | "gte", "lt" | "lte" | "gt" | "gte"> = { lt: "gt", lte: "gte", gt: "lt", gte: "lte" };

export function negateAtom(a: Atom): Atom {
  return { ...a, op: FLIP[a.op] } as Atom;
}

interface SimpleRef {
  root: AnalysableRoot;
  field: string;
}

function simpleRef(operand: Operand): SimpleRef | { reason: string } {
  if (!isRef(operand)) return { reason: "operand is not a reference" };
  const root = refRoot(operand.ref);
  const segs = refSegments(operand.ref);
  if (root !== "input" && root !== "self") return { reason: `references ${root ?? "?"}.* which the generator cannot control` };
  if (segs.length !== 1) return { reason: `nested path ${operand.ref} is not supported` };
  return { root, field: segs[0] as string };
}

function scalarLit(operand: Operand): LitScalar | { reason: string } {
  if (!isLit(operand)) return { reason: "operand is not a literal" };
  if (Array.isArray(operand.lit)) return { reason: "list literal outside `in`" };
  return operand.lit;
}

function isReason(x: unknown): x is { reason: string } {
  return typeof x === "object" && x !== null && "reason" in x;
}

function compareAtom(op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte", lhs: Operand, rhs: Operand): Atom | { reason: string } {
  // len(ref) <op> number
  if (typeof lhs === "object" && lhs !== null && "op" in lhs && lhs.op === "len" && isLit(rhs)) {
    if (op === "eq" || op === "ne") return { reason: "len equality is not derivable into a length range" };
    const ref = simpleRef(lhs.arg);
    if (isReason(ref)) return ref;
    const v = scalarLit(rhs);
    if (isReason(v)) return v;
    if (typeof v !== "number") return { reason: "len compared with a non-number" };
    const lenOp = `len${op.charAt(0).toUpperCase()}${op.slice(1)}` as "lenLt" | "lenLte" | "lenGt" | "lenGte";
    return { root: ref.root, field: ref.field, op: lenOp, value: v };
  }
  let refSide = lhs;
  let litSide = rhs;
  let cmp = op;
  if (isLit(lhs) && isRef(rhs)) {
    refSide = rhs;
    litSide = lhs;
    if (op !== "eq" && op !== "ne") cmp = MIRROR[op];
  }
  const ref = simpleRef(refSide);
  if (isReason(ref)) return ref;
  const v = scalarLit(litSide);
  if (isReason(v)) return v;
  if (cmp === "eq" || cmp === "ne") return { root: ref.root, field: ref.field, op: cmp, value: v };
  if (typeof v === "number") return { root: ref.root, field: ref.field, op: cmp, value: v };
  if (typeof v === "string" && isIsoDate(v)) return { root: ref.root, field: ref.field, op: cmp, value: v };
  return { reason: `${cmp} against a ${v === null ? "null" : typeof v} literal is not orderable` };
}

/** Analyse a tier-1 clause into a satisfying and a violating conjunction. */
export function analyseClause(expr: BoolExpr): ClauseAnalysis {
  switch (expr.op) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const atom = compareAtom(expr.op, expr.lhs, expr.rhs);
      if (isReason(atom)) return { ok: false, reason: atom.reason };
      return { ok: true, satisfy: [atom], violate: [negateAtom(atom)] };
    }
    case "in": {
      const ref = simpleRef(expr.lhs);
      if (isReason(ref)) return { ok: false, reason: ref.reason };
      if (!isLit(expr.rhs) || !Array.isArray(expr.rhs.lit)) return { ok: false, reason: "`in` over a non-literal list" };
      if (expr.rhs.lit.length === 0) return { ok: false, reason: "`in` over an empty list" };
      const atom: Atom = { root: ref.root, field: ref.field, op: "in", values: [...expr.rhs.lit] };
      return { ok: true, satisfy: [atom], violate: [negateAtom(atom)] };
    }
    case "isNull": {
      const ref = simpleRef(expr.arg);
      if (isReason(ref)) return { ok: false, reason: ref.reason };
      const atom: Atom = { root: ref.root, field: ref.field, op: "isNull" };
      return { ok: true, satisfy: [atom], violate: [negateAtom(atom)] };
    }
    case "not": {
      const inner = analyseClause(expr.arg);
      if (!inner.ok) return inner;
      return { ok: true, satisfy: inner.violate, violate: inner.satisfy };
    }
    case "and": {
      const parts = expr.args.map((a) => analyseClause(a));
      const bad = parts.find((p): p is { ok: false; reason: string } => !p.ok);
      if (bad) return bad;
      const good = parts as Array<{ ok: true; satisfy: Conjunction; violate: Conjunction }>;
      const satisfy = good.flatMap((p) => p.satisfy);
      // violate exactly one conjunct (the first), satisfy the rest
      const violate = good.flatMap((p, i) => (i === 0 ? p.violate : p.satisfy));
      return { ok: true, satisfy, violate };
    }
    case "or": {
      const parts = expr.args.map((a) => analyseClause(a));
      const bad = parts.find((p): p is { ok: false; reason: string } => !p.ok);
      if (bad) return bad;
      const good = parts as Array<{ ok: true; satisfy: Conjunction; violate: Conjunction }>;
      return { ok: true, satisfy: good[0]?.satisfy ?? [], violate: good.flatMap((p) => p.violate) };
    }
    case "exists":
      return { ok: false, reason: "`exists` over an owned list is not derivable" };
    case "emitted":
      return { ok: false, reason: "`emitted` is an event assertion, not an input constraint" };
    case "db.exists":
    case "db.none":
    case "db.unique":
      return { ok: false, reason: "predicate tier (fixture-based, not input-based)" };
  }
}

// ---------------------------------------------------------------------------
// Merging atoms into one constraint per field
// ---------------------------------------------------------------------------

export interface FieldConstraint {
  root: AnalysableRoot;
  field: string;
  eq?: LitScalar;
  ne: LitScalar[];
  in?: LitScalar[];
  notIn: LitScalar[];
  min?: { value: number | string; exclusive: boolean };
  max?: { value: number | string; exclusive: boolean };
  isNull?: boolean;
  lenMin?: number;
  lenMax?: number;
}

export type MergeResult = { ok: true; fields: FieldConstraint[] } | { ok: false; reason: string };

function same(a: LitScalar, b: LitScalar): boolean {
  return a === b;
}

function orderKey(v: number | string): number {
  return typeof v === "number" ? v : Date.parse(v);
}

/** Merge a conjunction into per-field constraints; detects plain contradictions. */
export function mergeConjunction(atoms: Conjunction): MergeResult {
  const byKey = new Map<string, FieldConstraint>();
  for (const atom of atoms) {
    const key = `${atom.root}.${atom.field}`;
    const c = byKey.get(key) ?? { root: atom.root, field: atom.field, ne: [], notIn: [] };
    byKey.set(key, c);
    switch (atom.op) {
      case "eq":
        if (c.eq !== undefined && !same(c.eq, atom.value)) return { ok: false, reason: `${key} must equal two different values` };
        c.eq = atom.value;
        break;
      case "ne":
        c.ne.push(atom.value);
        break;
      case "in":
        c.in = c.in ? c.in.filter((v) => atom.values.some((w) => same(v, w))) : [...atom.values];
        if (c.in.length === 0) return { ok: false, reason: `${key} has no value in both lists` };
        break;
      case "notIn":
        c.notIn.push(...atom.values);
        break;
      case "isNull":
        if (c.isNull === false) return { ok: false, reason: `${key} must be both null and non-null` };
        c.isNull = true;
        break;
      case "notNull":
        if (c.isNull === true) return { ok: false, reason: `${key} must be both null and non-null` };
        c.isNull = false;
        break;
      case "gt":
      case "gte": {
        const exclusive = atom.op === "gt";
        if (!c.min || orderKey(atom.value) > orderKey(c.min.value) || (orderKey(atom.value) === orderKey(c.min.value) && exclusive)) {
          c.min = { value: atom.value, exclusive };
        }
        break;
      }
      case "lt":
      case "lte": {
        const exclusive = atom.op === "lt";
        if (!c.max || orderKey(atom.value) < orderKey(c.max.value) || (orderKey(atom.value) === orderKey(c.max.value) && exclusive)) {
          c.max = { value: atom.value, exclusive };
        }
        break;
      }
      case "lenGt":
        c.lenMin = Math.max(c.lenMin ?? 0, atom.value + 1);
        break;
      case "lenGte":
        c.lenMin = Math.max(c.lenMin ?? 0, atom.value);
        break;
      case "lenLt":
        c.lenMax = Math.min(c.lenMax ?? Number.POSITIVE_INFINITY, atom.value - 1);
        break;
      case "lenLte":
        c.lenMax = Math.min(c.lenMax ?? Number.POSITIVE_INFINITY, atom.value);
        break;
    }
  }
  for (const [key, c] of byKey) {
    if (c.eq !== undefined) {
      const eq = c.eq;
      if (c.ne.some((v) => same(v, eq))) return { ok: false, reason: `${key} must equal and differ from the same value` };
      if (c.in && !c.in.some((v) => same(v, eq))) return { ok: false, reason: `${key} equals a value outside its list` };
      if (c.notIn.some((v) => same(v, eq))) return { ok: false, reason: `${key} equals an excluded value` };
      if (c.isNull === true && eq !== null) return { ok: false, reason: `${key} must be null and equal a value` };
      if (c.isNull === false && eq === null) return { ok: false, reason: `${key} must be non-null and null` };
    }
    if (c.in) {
      c.in = c.in.filter((v) => !c.ne.some((w) => same(v, w)) && !c.notIn.some((w) => same(v, w)));
      if (c.in.length === 0) return { ok: false, reason: `${key} has no admissible list value` };
    }
    if (c.min && c.max) {
      const lo = orderKey(c.min.value);
      const hi = orderKey(c.max.value);
      if (lo > hi || (lo === hi && (c.min.exclusive || c.max.exclusive))) return { ok: false, reason: `${key} has an empty numeric range` };
    }
    if (c.lenMin !== undefined && c.lenMax !== undefined && c.lenMin > c.lenMax) return { ok: false, reason: `${key} has an empty length range` };
    if (c.lenMax !== undefined && c.lenMax < 0) return { ok: false, reason: `${key} needs a negative length` };
  }
  return { ok: true, fields: [...byKey.values()].sort((a, b) => (`${a.root}.${a.field}` < `${b.root}.${b.field}` ? -1 : 1)) };
}

/** Roots referenced by a conjunction. */
export function rootsOf(atoms: Conjunction): AnalysableRoot[] {
  return [...new Set(atoms.map((a) => a.root))].sort();
}
