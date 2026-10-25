/**
 * Static lowering of `e.*` / `db.*` call chains to the contract AST (SPEC-CONTRACTS §4–5), mirroring
 * the `@averri/core` builders exactly (bare lhs paths rooted at `self`, nested `where` flattened to
 * dotted keys, canonical node key order) without importing core (D-2). Problems become structured
 * records the caller turns into diagnostics; a clause that cannot be represented is dropped.
 */

import { Node, type SourceFile } from "ts-morph";
import type {
  BoolExpr,
  CompareOp,
  DbCountWhere,
  DbWhere,
  DbWhereOperand,
  DbWhereValue,
  DiagnosticCode,
  EmittedExpr,
  EventId,
  Fix,
  LenExpr,
  Lit,
  LitScalar,
  Operand,
  Ref,
  RefPath,
  RefRoot,
} from "@averri/ir";
import { resolveDeclaration } from "@averri/extract";
import type { RefSite, RhsRefLiteral, WhereKeySite } from "../model.js";
import { builderOf, coreBindings, importsCore, type CoreBindings } from "./core-imports.js";
import { describeExpr, evalLiteral, propertyKey, unwrapExpr } from "./literal.js";

export const REF_ROOTS: readonly RefRoot[] = ["input", "result", "actor", "self", "old"];
export const MAX_PATH_DEPTH = 3;
export const WHERE_OPERATOR_KEYS = ["in", "not", "lt", "lte", "gt", "gte"] as const;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
export const REF_LITERAL_RE = /^(input|result|actor|self|old)\.[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export interface LowerProblem {
  code: DiagnosticCode;
  message: string;
  at: Node;
  fixes?: Fix[];
  /** True when the clause could not be represented and is dropped from the graph. */
  drop: boolean;
}

export interface ClauseEnv {
  /** Repo-relative path of a ts-morph source file. */
  rel(sf: SourceFile): string;
  /** Resolve an expression to a declared Event id (identifier of an `event()` const). */
  resolveEvent(expr: Node): EventId | null;
  sites: RefSite[];
  whereSites: WhereKeySite[];
  rhsRefLiterals: RhsRefLiteral[];
  problems: LowerProblem[];
}

export type Built =
  | { t: "clause"; ast: BoolExpr }
  | { t: "value"; ast: Operand }
  | { t: "dbvalue"; ast: DbCountWhere }
  | { t: "guard"; fn: Node }
  | { t: "fail" };

interface Scope {
  env: ClauseEnv;
  bindings: CoreBindings;
  file: string;
  inElement: boolean;
  depth: number;
}

function fail(scope: Scope, code: DiagnosticCode, message: string, at: Node, drop = true): Built {
  scope.env.problems.push({ code, message, at, drop });
  return { t: "fail" };
}

/** Lower one clause value (an option value under `requires`/`ensures`/`invariant`/`allow`). */
export function lowerClause(expr: Node, env: ClauseEnv): Built {
  const sf = expr.getSourceFile();
  return lowerBuilt(expr, { env, bindings: coreBindings(sf), file: env.rel(sf), inElement: false, depth: 0 });
}

function isFunctionLike(n: Node): boolean {
  return Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n);
}

function lowerBuilt(expr: Node, scope: Scope): Built {
  const n = unwrapExpr(expr);
  if (isFunctionLike(n)) return { t: "guard", fn: n };
  if (Node.isCallExpression(n)) {
    const callee = unwrapExpr(n.getExpression());
    if (Node.isPropertyAccessExpression(callee)) {
      const which = builderOf(callee.getExpression(), scope.bindings);
      if (which === "e") return lowerE(callee.getName(), n.getArguments(), n, scope);
      if (which === "db") return lowerDb(callee.getName(), n.getArguments(), n, scope);
    }
    return fail(scope, "A1004", `${describeExpr(n)} is not an e.*/db.* builder call`, n);
  }
  if (Node.isIdentifier(n) && scope.depth < 3) {
    const decl = resolveDeclaration(n);
    if (decl && isFunctionLike(decl)) return { t: "guard", fn: decl };
    if (decl && Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      const stmt = decl.getVariableStatement();
      if (init && stmt && stmt.getDeclarationKind() === "const") {
        const u = unwrapExpr(init);
        if (isFunctionLike(u)) return { t: "guard", fn: u };
        const dsf = decl.getSourceFile();
        if (importsCore(dsf)) {
          return lowerBuilt(init, { ...scope, bindings: coreBindings(dsf), file: scope.env.rel(dsf), depth: scope.depth + 1 });
        }
      }
    }
  }
  return fail(scope, "A1004", `${describeExpr(n)} is outside the statically analysable subset (expected e.*, db.* or a guard function)`, n);
}

// ---------------------------------------------------------------------------
// paths and refs
// ---------------------------------------------------------------------------

function staticStringArg(arg: Node | undefined): { value: string; node: Node } | null {
  if (!arg) return null;
  const u = unwrapExpr(arg);
  if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) return { value: u.getLiteralText(), node: u };
  return null;
}

function splitSegments(scope: Scope, raw: string, at: Node): string[] | null {
  const segs = raw.split(".");
  if (raw.length === 0 || segs.some((s) => !IDENT_RE.test(s))) {
    fail(scope, "A1004", `path ${JSON.stringify(raw)} is not a dotted identifier path`, at);
    return null;
  }
  return segs;
}

function isRoot(s: string): s is RefRoot {
  return (REF_ROOTS as readonly string[]).includes(s);
}

function recordSite(scope: Scope, ref: RefPath, kind: RefSite["kind"], raw: string, node: Node): void {
  scope.env.sites.push({ ref, kind, raw, file: scope.env.rel(node.getSourceFile()), start: node.getStart(), end: node.getEnd(), inElement: scope.inElement });
}

/** A left-hand path string: `"result.email"` stays, a bare `"status"` becomes `self.status`. */
function lowerPathString(scope: Scope, raw: string, node: Node, kind: "lhs" | "path"): Ref | null {
  const segs = splitSegments(scope, raw, node);
  if (!segs) return null;
  const qualified = segs.length > 1 && isRoot(segs[0] as string) ? segs : ["self", ...segs];
  if (qualified.length - 1 > MAX_PATH_DEPTH) {
    fail(scope, "A3004", `path ${JSON.stringify(raw)} has ${qualified.length - 1} segments after the root (max ${MAX_PATH_DEPTH})`, node);
    return null;
  }
  const ref = qualified.join(".") as RefPath;
  recordSite(scope, ref, kind, raw, node);
  return { ref };
}

function lowerRooted(scope: Scope, root: RefRoot, args: Node[], call: Node): Built {
  const s = staticStringArg(args[0]);
  if (!s) return fail(scope, "A1004", `e.${root}() needs a string literal field path`, args[0] ?? call);
  const segs = splitSegments(scope, s.value, s.node);
  if (!segs) return { t: "fail" };
  if (segs.length > MAX_PATH_DEPTH) {
    return fail(scope, "A3004", `e.${root}(${JSON.stringify(s.value)}) has ${segs.length} segments (max ${MAX_PATH_DEPTH})`, s.node);
  }
  const ref = `${root}.${segs.join(".")}` as RefPath;
  recordSite(scope, ref, "rooted", s.value, s.node);
  return { t: "value", ast: { ref } };
}

/** `Path | RefValue` arguments of isNull/len/sum/count/exists. */
function toRef(scope: Scope, arg: Node | undefined, call: Node): Ref | null {
  if (!arg) {
    fail(scope, "A1004", "missing path argument", call);
    return null;
  }
  const s = staticStringArg(arg);
  if (s) return lowerPathString(scope, s.value, s.node, "path");
  const b = lowerBuilt(arg, scope);
  if (b.t === "value" && "ref" in b.ast) return b.ast as Ref;
  if (b.t !== "fail") fail(scope, "A1004", `expected a path string or e.<root>() reference, got ${describeExpr(arg)}`, arg);
  return null;
}

/** Literal of an expression: syntax first, then the checker's literal type (`const PENDING = "pending"`). */
function literalOf(arg: Node): { ok: true; value: LitScalar } | { ok: false } {
  const r = evalLiteral(arg);
  if (r.ok) {
    const v = r.value;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { ok: true, value: v };
    return { ok: false };
  }
  const u = unwrapExpr(arg);
  if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
    try {
      const t = u.getType();
      if (t.isStringLiteral() || t.isNumberLiteral()) {
        const v = t.getLiteralValue();
        if (typeof v === "string" || typeof v === "number") return { ok: true, value: v };
      }
      if (t.isBooleanLiteral()) return { ok: true, value: t.getText() === "true" };
      if (t.isNull()) return { ok: true, value: null };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// e.*
// ---------------------------------------------------------------------------

const COMPARE_OPS = new Set<string>(["eq", "ne", "lt", "lte", "gt", "gte"]);

function lowerE(method: string, args: Node[], call: Node, scope: Scope): Built {
  if (isRoot(method)) return lowerRooted(scope, method, args, call);
  if (method === "lit") {
    const l = args[0] ? literalOf(args[0]) : ({ ok: false } as const);
    if (!l.ok) return fail(scope, "A1004", "e.lit() needs a literal scalar", args[0] ?? call);
    return { t: "value", ast: { lit: l.value } };
  }
  if (COMPARE_OPS.has(method)) {
    const lhs = lowerLhs(scope, args[0], call);
    const rhs = lowerRhs(scope, args[1], call);
    if (!lhs || !rhs) return { t: "fail" };
    return { t: "clause", ast: { op: method as CompareOp, lhs, rhs } };
  }
  if (method === "and" || method === "or") {
    if (args.length === 0) return fail(scope, "A1004", `e.${method}() needs at least one clause`, call);
    const out: BoolExpr[] = [];
    let ok = true;
    args.forEach((a) => {
      const b = lowerBuilt(a, scope);
      if (b.t === "clause") out.push(b.ast);
      else {
        ok = false;
        if (b.t === "guard") fail(scope, "A1004", `a guard (bare function) cannot be combined with e.${method}; write it as its own clause`, a);
        else if (b.t !== "fail") fail(scope, "A1004", `e.${method}() arguments must be clauses, got ${describeExpr(a)}`, a);
      }
    });
    return ok ? { t: "clause", ast: { op: method, args: out } } : { t: "fail" };
  }
  if (method === "not") {
    const b = args[0] ? lowerBuilt(args[0], scope) : fail(scope, "A1004", "e.not() needs a clause", call);
    if (b.t === "clause") return { t: "clause", ast: { op: "not", arg: b.ast } };
    if (b.t === "guard") return fail(scope, "A1004", "a guard (bare function) cannot be combined with e.not", args[0] as Node);
    if (b.t !== "fail") return fail(scope, "A1004", "e.not() argument must be a clause", args[0] as Node);
    return b;
  }
  if (method === "in") {
    const lhs = lowerLhs(scope, args[0], call);
    const listArg = args[1];
    if (!lhs || !listArg) return listArg ? { t: "fail" } : fail(scope, "A1004", "e.in() needs a list", call);
    const u = unwrapExpr(listArg);
    if (Node.isArrayLiteralExpression(u)) {
      const items: LitScalar[] = [];
      for (const el of u.getElements()) {
        const l = literalOf(el);
        if (!l.ok) return fail(scope, "A1004", `e.in() list element ${describeExpr(el)} is not a literal`, el);
        items.push(l.value);
      }
      return { t: "clause", ast: { op: "in", lhs, rhs: { lit: items } } };
    }
    const b = lowerBuilt(listArg, scope);
    if (b.t === "value" && "ref" in b.ast) return { t: "clause", ast: { op: "in", lhs, rhs: b.ast as Ref } };
    if (b.t === "fail") return b;
    return fail(scope, "A1004", "e.in() takes a literal list or a reference to a list field", listArg);
  }
  if (method === "isNull") {
    const r = toRef(scope, args[0], call);
    return r ? { t: "clause", ast: { op: "isNull", arg: r } } : { t: "fail" };
  }
  if (method === "len") {
    const r = toRef(scope, args[0], call);
    return r ? { t: "value", ast: { op: "len", arg: r } } : { t: "fail" };
  }
  if (method === "sum") {
    const r = toRef(scope, args[0], call);
    const f = staticStringArg(args[1]);
    if (!f) return fail(scope, "A1004", "e.sum() needs a string literal field name", args[1] ?? call);
    return r ? { t: "value", ast: { op: "sum", path: r, field: f.value } } : { t: "fail" };
  }
  if (method === "count" || method === "exists") {
    const r = toRef(scope, args[0], call);
    let where: BoolExpr | undefined;
    if (args[1]) {
      const b = lowerBuilt(args[1], { ...scope, inElement: true });
      if (b.t === "clause") {
        if (containsDb(b.ast)) return fail(scope, "A3009", `the element filter of e.${method}() contains a db.* predicate`, args[1]);
        where = b.ast;
      } else if (b.t === "fail") return b;
      else return fail(scope, "A1004", `e.${method}() element filter must be an e.* clause`, args[1]);
    }
    if (!r) return { t: "fail" };
    if (method === "count") return { t: "value", ast: where ? { op: "count", path: r, where } : { op: "count", path: r } };
    return { t: "clause", ast: where ? { op: "exists", path: r, where } : { op: "exists", path: r } };
  }
  if (method === "emitted") {
    const evArg = args[0];
    if (!evArg) return fail(scope, "A1004", "e.emitted() needs an event declaration", call);
    const ev = scope.env.resolveEvent(evArg);
    if (!ev) return fail(scope, "A4001", `${unwrapExpr(evArg).getText()} is not a declared event() (e.emitted)`, evArg);
    let count: EmittedExpr["count"] | undefined;
    if (args[1]) {
      const r = evalLiteral(args[1]);
      if (r.ok && typeof r.value === "number" && Number.isInteger(r.value) && r.value >= 0) count = r.value;
      else if (r.ok && typeof r.value === "object" && r.value !== null && !Array.isArray(r.value)) {
        const range: { min?: number; max?: number } = {};
        for (const k of Object.keys(r.value)) {
          const v = r.value[k];
          if ((k !== "min" && k !== "max") || typeof v !== "number" || !Number.isInteger(v) || v < 0) {
            return fail(scope, "A1004", "e.emitted() count must be a non-negative integer or { min?, max? }", args[1]);
          }
          range[k] = v;
        }
        if (range.min === undefined && range.max === undefined) return fail(scope, "A1004", "e.emitted() count range needs min or max", args[1]);
        count = range;
      } else return fail(scope, "A1004", "e.emitted() count must be a non-negative integer or { min?, max? }", args[1]);
    }
    return { t: "clause", ast: count === undefined ? { op: "emitted", event: ev } : { op: "emitted", event: ev, count } };
  }
  return fail(scope, "A1004", `e.${method} is not an expression builder`, call);
}

function lowerLhs(scope: Scope, arg: Node | undefined, call: Node): Operand | null {
  if (!arg) {
    fail(scope, "A1004", "missing left-hand operand", call);
    return null;
  }
  const s = staticStringArg(arg);
  if (s) return lowerPathString(scope, s.value, s.node, "lhs");
  const b = lowerBuilt(arg, scope);
  if (b.t === "value" || b.t === "dbvalue") return b.ast;
  if (b.t !== "fail") fail(scope, "A1004", `left-hand operand must be a path string or a built value, got ${describeExpr(arg)}`, arg);
  return null;
}

function lowerRhs(scope: Scope, arg: Node | undefined, call: Node): Operand | null {
  if (!arg) {
    fail(scope, "A1004", "missing right-hand operand", call);
    return null;
  }
  const u = unwrapExpr(arg);
  if (Node.isCallExpression(u)) {
    const b = lowerBuilt(arg, scope);
    if (b.t === "value" || b.t === "dbvalue") return b.ast;
    if (b.t === "clause") fail(scope, "A1004", "the right-hand side must be a value or literal, not a boolean clause", arg);
    return null;
  }
  const l = literalOf(arg);
  if (l.ok) {
    if (typeof l.value === "string" && REF_LITERAL_RE.test(l.value)) {
      scope.env.rhsRefLiterals.push({ value: l.value, file: scope.env.rel(arg.getSourceFile()), start: u.getStart(), end: u.getEnd() });
    }
    return { lit: l.value };
  }
  const b = lowerBuilt(arg, scope);
  if (b.t === "value" || b.t === "dbvalue") return b.ast;
  return null;
}

// ---------------------------------------------------------------------------
// db.*
// ---------------------------------------------------------------------------

function containsDb(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsDb);
  if (typeof node !== "object" || node === null) return false;
  const r = node as Record<string, unknown>;
  if (typeof r.op === "string" && r.op.startsWith("db.")) return true;
  return Object.keys(r).some((k) => containsDb(r[k]));
}

function lowerDb(method: string, args: Node[], call: Node, scope: Scope): Built {
  if (method !== "exists" && method !== "none" && method !== "unique" && method !== "countWhere") {
    return fail(scope, "A1004", `db.${method} is not a predicate builder`, call);
  }
  const m = staticStringArg(args[0]);
  if (!m) return fail(scope, "A1004", `db.${method}() needs a string literal model accessor`, args[0] ?? call);
  if (!IDENT_RE.test(m.value)) return fail(scope, "A1004", `${JSON.stringify(m.value)} is not a Prisma client accessor`, m.node);
  const whereArg = args[1];
  if (!whereArg) return fail(scope, "A1004", `db.${method}() needs a where object`, call);
  const where = flattenWhere(scope, m.value, whereArg);
  if (!where) return { t: "fail" };
  if (method === "countWhere") return { t: "dbvalue", ast: { op: "db.countWhere", model: m.value, where } };
  return { t: "clause", ast: { op: `db.${method}`, model: m.value, where } as BoolExpr };
}

/** Flatten a standalone where object (`subject.where`) with the same rules as db.* predicates. */
export function lowerStandaloneWhere(expr: Node, model: string, env: ClauseEnv): DbWhere | null {
  const sf = expr.getSourceFile();
  return flattenWhere({ env, bindings: coreBindings(sf), file: env.rel(sf), inElement: false, depth: 0 }, model, expr);
}

function flattenWhere(scope: Scope, model: string, arg: Node): DbWhere | null {
  const u = unwrapExpr(arg);
  if (!Node.isObjectLiteralExpression(u)) {
    fail(scope, "A1004", `a where must be an object literal, got ${describeExpr(arg)}`, arg);
    return null;
  }
  const out: Record<string, DbWhereValue> = {};
  return flattenInto(scope, model, u, [], out) ? (out as DbWhere) : null;
}

function flattenInto(scope: Scope, model: string, obj: Node, prefix: string[], out: Record<string, DbWhereValue>): boolean {
  if (!Node.isObjectLiteralExpression(obj)) return false;
  let ok = true;
  for (const p of obj.getProperties()) {
    if (!Node.isPropertyAssignment(p)) {
      fail(scope, "A1004", `where entries must be plain properties, got ${describeExpr(p)}`, p);
      ok = false;
      continue;
    }
    const key = propertyKey(p);
    if (key === null || !IDENT_RE.test(key)) {
      fail(scope, "A1004", "where keys must be static identifiers", p);
      ok = false;
      continue;
    }
    const pathSegs = [...prefix, key];
    const dotted = pathSegs.join(".");
    if ((WHERE_OPERATOR_KEYS as readonly string[]).includes(key)) {
      fail(scope, "A3002", `a field named ${JSON.stringify(key)} cannot be addressed in a where (operator keyword)`, p);
      ok = false;
      continue;
    }
    if (pathSegs.length > MAX_PATH_DEPTH) {
      fail(scope, "A3009", `where path ${dotted} is deeper than ${MAX_PATH_DEPTH} segments`, p);
      ok = false;
      continue;
    }
    const nameNode = p.getNameNode();
    scope.env.whereSites.push({
      model,
      key: dotted,
      file: scope.env.rel(p.getSourceFile()),
      start: nameNode.getStart(),
      end: nameNode.getEnd(),
      flat: prefix.length === 0,
    });
    const init = p.getInitializer();
    if (!init) continue;
    const v = unwrapExpr(init);
    if (Node.isObjectLiteralExpression(v)) {
      const keys = v.getProperties().map((q) => propertyKey(q));
      const opKeys = keys.filter((k): k is string => k !== null && (WHERE_OPERATOR_KEYS as readonly string[]).includes(k));
      if (opKeys.length > 0) {
        if (keys.length !== 1) {
          fail(scope, "A1004", `an operator form takes exactly one of { in, not, lt, lte, gt, gte }`, v);
          ok = false;
          continue;
        }
        const op = opKeys[0] as (typeof WHERE_OPERATOR_KEYS)[number];
        const prop = v.getProperties()[0];
        const opInit = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
        if (!opInit) {
          fail(scope, "A1004", "operator form without a value", v);
          ok = false;
          continue;
        }
        const lowered = lowerOperatorForm(scope, op, opInit);
        if (!lowered) {
          ok = false;
          continue;
        }
        out[dotted] = lowered;
        continue;
      }
      if (keys.length === 0) {
        fail(scope, "A1004", "nested where object is empty", v);
        ok = false;
        continue;
      }
      if (!flattenInto(scope, model, v, pathSegs, out)) ok = false;
      continue;
    }
    const val = lowerWhereScalar(scope, init);
    if (!val) {
      ok = false;
      continue;
    }
    out[dotted] = val as DbWhereValue;
  }
  return ok;
}

function lowerWhereScalar(scope: Scope, init: Node): DbWhereOperand | null {
  const u = unwrapExpr(init);
  if (Node.isCallExpression(u)) {
    const b = lowerBuilt(init, scope);
    if (b.t === "value") {
      const ast = b.ast as { op?: string };
      if ("ref" in b.ast || "lit" in b.ast || ast.op === "len") return b.ast as Ref | Lit | LenExpr;
      fail(scope, "A3009", `e.${String(ast.op)}() cannot appear inside a where (only refs, literals and e.len())`, init);
      return null;
    }
    if (b.t === "dbvalue") {
      fail(scope, "A3009", "db.countWhere() cannot appear inside a where", init);
      return null;
    }
    if (b.t === "clause") fail(scope, "A1004", "where values are refs, literals or operator forms, not boolean clauses", init);
    return null;
  }
  const l = literalOf(init);
  if (l.ok) return { lit: l.value };
  fail(scope, "A1004", `where value ${describeExpr(init)} is not statically analysable`, init);
  return null;
}

function lowerOperatorForm(scope: Scope, op: (typeof WHERE_OPERATOR_KEYS)[number], operand: Node): DbWhereValue | null {
  if (op === "in") {
    const u = unwrapExpr(operand);
    if (Node.isArrayLiteralExpression(u)) {
      const items: LitScalar[] = [];
      for (const el of u.getElements()) {
        const l = literalOf(el);
        if (!l.ok) {
          fail(scope, "A1004", `{ in } list element ${describeExpr(el)} is not a literal`, el);
          return null;
        }
        items.push(l.value);
      }
      return { in: { lit: items } };
    }
    const b = lowerBuilt(operand, scope);
    if (b.t === "value" && "ref" in b.ast) return { in: b.ast as Ref };
    if (b.t !== "fail") fail(scope, "A1004", "{ in } takes a literal list or a reference to a list field", operand);
    return null;
  }
  const v = lowerWhereScalar(scope, operand);
  if (!v) return null;
  if (op === "not") {
    if ("op" in v) {
      fail(scope, "A1004", "{ not } takes a reference or a literal, not e.len()", operand);
      return null;
    }
    return { not: v };
  }
  return { [op]: v } as DbWhereValue;
}
