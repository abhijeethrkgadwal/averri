/**
 * Contract AST utilities (SPEC-CONTRACTS §3–§5): walking, reference collection, tier derivation,
 * canonical JSON and stable hashing. Pure functions; no IO.
 */

import { createHash } from "node:crypto";

import type {
  BoolExpr,
  ContractExpr,
  ContractOp,
  ContractTier,
  DbWhere,
  DbWhereValue,
  EventId,
  Lit,
  Ref,
  RefPath,
  RefRoot,
} from "./types.js";

/** Every `op` string that makes a clause a predicate. */
export const DB_OPS = ["db.exists", "db.none", "db.unique", "db.countWhere"] as const;
export type DbOp = (typeof DB_OPS)[number];

export function isDbOp(op: string): op is DbOp {
  return op === "db.exists" || op === "db.none" || op === "db.unique" || op === "db.countWhere";
}

export function isRef(value: unknown): value is Ref {
  return typeof value === "object" && value !== null && typeof (value as Ref).ref === "string" && !("op" in value);
}

export function isLit(value: unknown): value is Lit {
  return typeof value === "object" && value !== null && "lit" in value && !("op" in value);
}

/** True for any AST node carrying an `op` (operators and predicates; not refs or literals). */
export function hasOp(value: unknown): value is Extract<ContractExpr, { op: string }> {
  return typeof value === "object" && value !== null && typeof (value as { op?: unknown }).op === "string";
}

/** The `op` of a node, or `"ref"` / `"lit"` for leaves. */
export function opOf(node: ContractExpr): ContractOp | "ref" | "lit" {
  if (hasOp(node)) return node.op;
  return isRef(node) ? "ref" : "lit";
}

/**
 * Where-clause operand leaves: refs, literals and `len` operands, with the dotted key and operator
 * they sit under. `operator` is `null` for a bare `key: value` entry.
 */
export interface WhereLeaf {
  key: string;
  operator: "in" | "not" | "lt" | "lte" | "gt" | "gte" | null;
  value: ContractExpr;
}

export function whereLeaves(where: DbWhere): WhereLeaf[] {
  const out: WhereLeaf[] = [];
  for (const key of Object.keys(where)) {
    const value = where[key] as DbWhereValue;
    if (isRef(value) || isLit(value)) {
      out.push({ key, operator: null, value });
      continue;
    }
    for (const operator of ["in", "not", "lt", "lte", "gt", "gte"] as const) {
      if (operator in value) {
        out.push({ key, operator, value: (value as Record<string, ContractExpr>)[operator] as ContractExpr });
      }
    }
  }
  return out;
}

export interface WalkContext {
  /** Path of property names/indices from the root to this node, e.g. `["args", 1, "lhs"]`. */
  path: Array<string | number>;
  /** Number of enclosing `not` nodes; odd means negated polarity. */
  negations: number;
  /** True when the node sits inside a `db.*` `where` clause. */
  inWhere: boolean;
  /** The enclosing `where` key when `inWhere`. */
  whereKey: string | null;
  /** Number of ancestor nodes (0 at the root). */
  depth: number;
}

export type Visitor = (node: ContractExpr, ctx: WalkContext) => void | false;

/**
 * Depth-first pre-order walk over every AST node, including operands and the ref/literal/`len`
 * leaves inside `db.*` `where` clauses. Returning `false` from the visitor skips the node's children.
 */
export function walkExpr(root: ContractExpr, visit: Visitor): void {
  const go = (node: ContractExpr, ctx: WalkContext): void => {
    if (visit(node, ctx) === false) return;
    if (!hasOp(node)) return;
    const child = (n: ContractExpr, ...segs: Array<string | number>): void => go(n, { ...ctx, path: [...ctx.path, ...segs], depth: ctx.depth + 1 });
    switch (node.op) {
      case "eq":
      case "ne":
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        child(node.lhs, "lhs");
        child(node.rhs, "rhs");
        return;
      case "and":
      case "or":
        node.args.forEach((a, i) => child(a, "args", i));
        return;
      case "not":
        go(node.arg, { ...ctx, path: [...ctx.path, "arg"], negations: ctx.negations + 1, depth: ctx.depth + 1 });
        return;
      case "in":
        child(node.lhs, "lhs");
        child(node.rhs, "rhs");
        return;
      case "isNull":
      case "len":
        child(node.arg, "arg");
        return;
      case "exists":
      case "count":
        child(node.path, "path");
        if (node.where) child(node.where, "where");
        return;
      case "sum":
        child(node.path, "path");
        return;
      case "emitted":
        return;
      case "db.exists":
      case "db.none":
      case "db.unique":
      case "db.countWhere":
        for (const leaf of whereLeaves(node.where)) {
          const segs: Array<string | number> = leaf.operator ? ["where", leaf.key, leaf.operator] : ["where", leaf.key];
          go(leaf.value, { ...ctx, path: [...ctx.path, ...segs], inWhere: true, whereKey: leaf.key, depth: ctx.depth + 1 });
        }
        return;
    }
  };
  go(root, { path: [], negations: 0, inWhere: false, whereKey: null, depth: 0 });
}

/** All `op` strings present in the AST, in first-seen pre-order. */
export function collectOps(root: ContractExpr): ContractOp[] {
  const seen: ContractOp[] = [];
  walkExpr(root, (n) => {
    if (hasOp(n) && !seen.includes(n.op)) seen.push(n.op);
  });
  return seen;
}

/** Every ref path in the AST (including `where` refs), sorted and unique. */
export function collectRefs(root: ContractExpr): RefPath[] {
  const set = new Set<RefPath>();
  walkExpr(root, (n) => {
    if (isRef(n)) set.add(n.ref);
  });
  return [...set].sort();
}

/** Root of a ref path (`self.lines.amount` -> `self`). */
export function refRoot(ref: RefPath | string): RefRoot | null {
  const dot = ref.indexOf(".");
  const root = dot < 0 ? ref : ref.slice(0, dot);
  return root === "input" || root === "result" || root === "actor" || root === "self" || root === "old" ? root : null;
}

/** Segments after the root (`self.lines.amount` -> `["lines", "amount"]`). */
export function refSegments(ref: RefPath | string): string[] {
  const parts = ref.split(".");
  return parts.slice(1);
}

/** Distinct ref roots used by the AST, sorted. */
export function collectRefRoots(root: ContractExpr): RefRoot[] {
  const set = new Set<RefRoot>();
  for (const r of collectRefs(root)) {
    const rr = refRoot(r);
    if (rr) set.add(rr);
  }
  return [...set].sort();
}

/** Prisma client accessor names referenced by `db.*` nodes, sorted and unique. */
export function collectDbModels(root: ContractExpr): string[] {
  const set = new Set<string>();
  walkExpr(root, (n) => {
    if (hasOp(n) && isDbOp(n.op)) set.add((n as { model: string }).model);
  });
  return [...set].sort();
}

/** Event ids named by `emitted` nodes, sorted and unique. */
export function collectEmittedEvents(root: ContractExpr): EventId[] {
  const set = new Set<EventId>();
  walkExpr(root, (n) => {
    if (hasOp(n) && n.op === "emitted") set.add(n.event);
  });
  return [...set].sort();
}

/** Every `db.*` node with its (model, where) pair, in pre-order. */
export function collectDbPredicates(root: ContractExpr): Array<{ op: DbOp; model: string; where: DbWhere }> {
  const out: Array<{ op: DbOp; model: string; where: DbWhere }> = [];
  walkExpr(root, (n) => {
    if (hasOp(n) && isDbOp(n.op)) out.push({ op: n.op, model: (n as { model: string }).model, where: (n as { where: DbWhere }).where });
  });
  return out;
}

/** True when the AST contains at least one `db.*` node. */
export function containsDbOp(root: ContractExpr): boolean {
  let found = false;
  walkExpr(root, (n) => {
    if (found) return false;
    if (hasOp(n) && isDbOp(n.op)) {
      found = true;
      return false;
    }
  });
  return found;
}

/**
 * Tier derivation (SPEC-CONTRACTS §3): a function is a `guard`; an AST with any `db.*` node is a
 * `predicate`; anything else is an `expr`. `null` (the stored form of a guard's AST) is a guard.
 */
export function tierOf(clause: ContractExpr | ((...args: never[]) => unknown) | null | undefined): ContractTier {
  if (clause === null || clause === undefined || typeof clause === "function") return "guard";
  return containsDbOp(clause) ? "predicate" : "expr";
}

/** Maximum AST depth (a leaf has depth 1). */
export function exprDepth(root: ContractExpr): number {
  let max = 0;
  walkExpr(root, (_n, ctx) => {
    if (ctx.depth + 1 > max) max = ctx.depth + 1;
  });
  return max;
}

// --- canonical JSON and hashing ---------------------------------------------------

/**
 * Deterministic JSON: object keys sorted (code-unit order), `undefined` properties dropped, arrays
 * kept in order, no whitespace unless `indent` is given. Non-finite numbers and bigints throw.
 */
export function canonicalJson(value: unknown, indent = 0): string {
  const normalised = normaliseForJson(value);
  return indent > 0 ? JSON.stringify(normalised, null, indent) : JSON.stringify(normalised);
}

function normaliseForJson(value: unknown): unknown {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${String(value)}`);
    return value;
  }
  if (typeof value === "bigint") throw new TypeError("canonicalJson: bigint is not JSON-serialisable");
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normaliseForJson(v)));
  if (typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return normaliseForJson((value as { toJSON: () => unknown }).toJSON());
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = normaliseForJson(v);
    }
    return out;
  }
  return undefined;
}

/** sha256 hex of {@link canonicalJson}; the stable hash used for `sourceHash` and AST identity. */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Structural equality through canonical JSON (key order and `undefined` properties ignored). */
export function exprEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Human-readable rendering of a clause for spec cards and default violation messages. */
export function renderExpr(node: ContractExpr): string {
  if (isRef(node)) return node.ref;
  if (isLit(node)) return JSON.stringify(node.lit);
  const n = node as Extract<ContractExpr, { op: string }>;
  const cmp: Record<string, string> = { eq: "==", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };
  switch (n.op) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return `${renderExpr(n.lhs)} ${cmp[n.op]} ${renderExpr(n.rhs)}`;
    case "and":
      return n.args.map((a) => wrap(a, renderExpr(a))).join(" and ");
    case "or":
      return n.args.map((a) => wrap(a, renderExpr(a))).join(" or ");
    case "not":
      return `not ${wrap(n.arg, renderExpr(n.arg))}`;
    case "in":
      return `${renderExpr(n.lhs)} in ${renderExpr(n.rhs)}`;
    case "isNull":
      return `${n.arg.ref} is null`;
    case "len":
      return `len(${n.arg.ref})`;
    case "sum":
      return `sum(${n.path.ref}.${n.field})`;
    case "count":
      return n.where ? `count(${n.path.ref} where ${renderExpr(n.where)})` : `count(${n.path.ref})`;
    case "exists":
      return n.where ? `exists(${n.path.ref} where ${renderExpr(n.where)})` : `exists(${n.path.ref})`;
    case "emitted": {
      const c = n.count;
      const count =
        c === undefined ? "" : typeof c === "number" ? ` x${c}` : ` x[${c.min ?? 0}..${c.max === undefined ? "" : c.max}]`;
      return `emitted ${n.event}${count}`;
    }
    case "db.exists":
    case "db.none":
    case "db.unique":
    case "db.countWhere":
      return `${n.op}(${n.model} where ${renderWhere(n.where)})`;
  }
}

function wrap(node: BoolExpr, text: string): string {
  return hasOp(node) && (node.op === "and" || node.op === "or") ? `(${text})` : text;
}

function renderWhere(where: DbWhere): string {
  return whereLeaves(where)
    .map((l) => (l.operator ? `${l.key} ${l.operator} ${renderExpr(l.value)}` : `${l.key} = ${renderExpr(l.value)}`))
    .join(", ");
}
