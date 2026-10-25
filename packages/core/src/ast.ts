/**
 * AST helpers shared by the builders and the constructors: path normalisation, operand lowering,
 * tier derivation, `where` flattening (D-3) and reference collection. Pure functions, no I/O.
 */
import type {
  BoolExpr,
  ContractTier,
  DbWhere,
  DbWhereOperand,
  DbWhereValue,
  LenExpr,
  Lit,
  LitScalar,
  Operand,
  Ref,
  RefPath,
  RefRoot,
} from "@averri/ir";
import type { AnalysableClause, Clause, DbValue, RefValue, ScalarValue, Value } from "./types.js";
import { AverriDeclarationError, describe, isPlainObject } from "./errors.js";
import { IDENTIFIER_RE, REF_ROOT_VALUES, WHERE_OPERATOR_KEYS, type WhereOperatorKey } from "./literals.js";

/** Maximum number of segments after the root (A3004) and maximum `where` key depth (A3009). */
export const MAX_PATH_DEPTH = 3;

const ROOT_SET: ReadonlySet<string> = new Set(REF_ROOT_VALUES);

export function isRefRoot(value: string): value is RefRoot {
  return ROOT_SET.has(value);
}

/** True for `{ tier: "value" | "dbvalue", ast }` objects produced by the builders. */
export function isValueOperand(value: unknown): value is Value | DbValue {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { tier?: unknown }).tier === "value" || (value as { tier?: unknown }).tier === "dbvalue") &&
    typeof (value as { ast?: unknown }).ast === "object" &&
    (value as { ast?: unknown }).ast !== null
  );
}

/** True for `{ tier: "expr" | "predicate", ast }` objects produced by the builders. */
export function isAnalysableClause(value: unknown): value is AnalysableClause {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { tier?: unknown }).tier === "expr" || (value as { tier?: unknown }).tier === "predicate") &&
    typeof (value as { ast?: unknown }).ast === "object" &&
    (value as { ast?: unknown }).ast !== null
  );
}

/** Runtime discrimination of the three tiers: a function is a guard (D-1). */
export function isGuard(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

export function isClause(value: unknown): value is Clause {
  return isGuard(value) || isAnalysableClause(value);
}

export function isLitScalar(value: unknown): value is LitScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Validates a dotted path (`a`, `a.b.c`) made of identifiers. Returns the segments. */
export function splitPath(construct: string, option: string | null, path: unknown): string[] {
  if (typeof path !== "string" || path.length === 0) {
    throw new AverriDeclarationError(construct, null, option, `expected a non-empty path string, got ${describe(path)}`);
  }
  const segments = path.split(".");
  for (const segment of segments) {
    if (!IDENTIFIER_RE.test(segment)) {
      throw new AverriDeclarationError(
        construct,
        null,
        option,
        `path ${JSON.stringify(path)} has an invalid segment ${JSON.stringify(segment)} (segments must be identifiers separated by ".")`,
      );
    }
  }
  return segments;
}

/**
 * Normalises a left-hand path to a root-qualified `RefPath` (SPEC-CONTRACTS §2, the one-line rule):
 * `"result.email"` stays; a bare `"status"` becomes `"self.status"` (inside `invariant` self is the row).
 * A doubled prefix (`e.input("input.teamId")`) is NOT normalised; the compiler reports it (A3002).
 */
export function normalisePath(construct: string, option: string | null, path: unknown): RefPath {
  const segments = splitPath(construct, option, path);
  const first = segments[0] as string;
  const qualified = segments.length > 1 && isRefRoot(first) ? segments : ["self", ...segments];
  if (qualified.length - 1 > MAX_PATH_DEPTH) {
    throw new AverriDeclarationError(
      construct,
      null,
      option,
      `path ${JSON.stringify(path)} is deeper than ${MAX_PATH_DEPTH} segments after the root (A3004)`,
    );
  }
  return qualified.join(".") as RefPath;
}

/** Builds `{ ref: "<root>.<field>" }` for `e.input(field)` and friends. The field is not re-rooted. */
export function rootedRef(construct: string, root: RefRoot, field: unknown): Ref {
  const segments = splitPath(construct, null, field);
  if (segments.length > MAX_PATH_DEPTH) {
    throw new AverriDeclarationError(construct, null, null, `field ${JSON.stringify(field)} is deeper than ${MAX_PATH_DEPTH} segments (A3004)`);
  }
  return Object.freeze({ ref: `${root}.${segments.join(".")}` as RefPath });
}

/** Accepts a path string or a `RefValue` and returns the `Ref` node. */
export function toRef(construct: string, option: string | null, value: unknown): Ref {
  if (typeof value === "string") return Object.freeze({ ref: normalisePath(construct, option, value) });
  if (isValueOperand(value) && "ref" in value.ast) return value.ast as Ref;
  throw new AverriDeclarationError(
    construct,
    null,
    option,
    `expected a path string or a reference (e.input(), e.actor(), e.self(), e.old(), e.result()), got ${describeOperand(value)}`,
  );
}

export function describeOperand(value: unknown): string {
  if (isValueOperand(value)) {
    const ast = value.ast as { op?: string; ref?: string; lit?: unknown };
    if (typeof ast.ref === "string") return `the reference ${ast.ref}`;
    if ("lit" in ast) return `the literal ${JSON.stringify(ast.lit)}`;
    if (typeof ast.op === "string") return `a ${ast.op}() value`;
  }
  if (isAnalysableClause(value)) return `a ${value.tier} clause`;
  return describe(value);
}

/** Lowers a left-hand operand: path string → Ref; built value → its AST. */
export function lowerLhs(construct: string, value: unknown): Operand {
  if (typeof value === "string") return Object.freeze({ ref: normalisePath(construct, "lhs", value) });
  if (isValueOperand(value)) return value.ast;
  throw new AverriDeclarationError(
    construct,
    null,
    "lhs",
    `expected a path string or a built value (e.input(), e.len(), e.sum(), e.count(), db.countWhere()), got ${describeOperand(value)}`,
  );
}

/** Lowers a right-hand operand: built value → its AST; everything else must be a literal scalar (strings are ALWAYS literals). */
export function lowerRhs(construct: string, value: unknown): Operand {
  if (isValueOperand(value)) return value.ast;
  if (isLitScalar(value)) return Object.freeze({ lit: value });
  if (isAnalysableClause(value)) {
    throw new AverriDeclarationError(construct, null, "rhs", "expected a value or literal, got a boolean clause (nest it with e.and/e.or instead)");
  }
  throw new AverriDeclarationError(
    construct,
    null,
    "rhs",
    `expected a literal (string, finite number, boolean, null) or a built value, got ${describeOperand(value)}`,
  );
}

export function lowerLit(construct: string, option: string | null, value: unknown): Lit {
  if (isLitScalar(value)) return Object.freeze({ lit: value });
  throw new AverriDeclarationError(construct, null, option, `expected a literal (string, finite number, boolean, null), got ${describeOperand(value)}`);
}

export function lowerLitList(construct: string, option: string | null, value: unknown): Lit {
  if (!Array.isArray(value)) {
    throw new AverriDeclarationError(construct, null, option, `expected an array of literals or a reference, got ${describeOperand(value)}`);
  }
  value.forEach((item, index) => {
    if (!isLitScalar(item)) {
      throw new AverriDeclarationError(
        construct,
        null,
        option,
        `element ${index} is not a literal (string, finite number, boolean, null): ${describeOperand(item)}`,
      );
    }
  });
  return Object.freeze({ lit: Object.freeze([...(value as LitScalar[])]) as LitScalar[] });
}

/** Operand allowed inside a `where` operator form: a ref, a literal or `e.len()` (never sum/count/db.countWhere; A3009). */
export function lowerWhereOperand(construct: string, option: string, value: unknown): DbWhereOperand {
  if (isLitScalar(value)) return Object.freeze({ lit: value });
  if (isValueOperand(value)) {
    const ast = value.ast as { op?: string };
    if ("ref" in ast || "lit" in ast || ast.op === "len") return value.ast as Ref | Lit | LenExpr;
    const name = ast.op === "db.countWhere" ? "db.countWhere()" : `e.${String(ast.op)}()`;
    throw new AverriDeclarationError(construct, null, option, `${name} cannot appear inside a where (only refs, literals and e.len(); A3009)`);
  }
  throw new AverriDeclarationError(construct, null, option, `expected a literal, a reference or e.len(), got ${describeOperand(value)}`);
}

// ---------------------------------------------------------------------------
// where flattening (D-3)
// ---------------------------------------------------------------------------

/**
 * Flattens a user-written `WhereInput` into the canonical flat `DbWhere`: nested objects become dotted
 * keys (`user: { email }` → `"user.email"`), literals become `{ lit }`, built values become their AST,
 * operator forms become `{ in | not | lt | lte | gt | gte: operand }`. Key order is source order.
 */
export function flattenWhere(construct: string, option: string, input: unknown): DbWhere {
  if (!isPlainObject(input)) {
    throw new AverriDeclarationError(construct, null, option, `expected a where object, got ${describe(input)}`);
  }
  const out: Record<string, DbWhereValue> = {};
  flattenInto(construct, option, input, [], out);
  return Object.freeze(out) as DbWhere;
}

function flattenInto(
  construct: string,
  option: string,
  input: Record<string, unknown>,
  prefix: string[],
  out: Record<string, DbWhereValue>,
): void {
  for (const key of Object.keys(input)) {
    const value = input[key];
    const path = [...prefix, key];
    const dotted = path.join(".");
    const optionPath = `${option}.${dotted}`;
    if (!IDENTIFIER_RE.test(key)) {
      throw new AverriDeclarationError(construct, null, optionPath, `where key ${JSON.stringify(key)} is not an identifier`);
    }
    if ((WHERE_OPERATOR_KEYS as readonly string[]).includes(key)) {
      throw new AverriDeclarationError(
        construct,
        null,
        optionPath,
        `a field named ${JSON.stringify(key)} cannot be addressed in a where (operator keyword; A3002)`,
      );
    }
    if (path.length > MAX_PATH_DEPTH) {
      throw new AverriDeclarationError(construct, null, optionPath, `where path is deeper than ${MAX_PATH_DEPTH} segments (A3009)`);
    }
    if (value === undefined) {
      throw new AverriDeclarationError(
        construct,
        null,
        optionPath,
        "where value is undefined (Prisma would drop the filter; use null or omit the key)",
      );
    }
    if (isLitScalar(value)) {
      out[dotted] = Object.freeze({ lit: value });
      continue;
    }
    if (isValueOperand(value)) {
      out[dotted] = lowerWhereOperand(construct, optionPath, value) as DbWhereValue;
      continue;
    }
    if (isAnalysableClause(value)) {
      throw new AverriDeclarationError(construct, null, optionPath, "where values are refs, literals or operator forms, not boolean clauses");
    }
    if (!isPlainObject(value)) {
      throw new AverriDeclarationError(construct, null, optionPath, `unsupported where value ${describeOperand(value)}`);
    }
    const keys = Object.keys(value);
    const operatorKeys = keys.filter((k) => (WHERE_OPERATOR_KEYS as readonly string[]).includes(k));
    if (operatorKeys.length > 0) {
      if (keys.length !== 1) {
        throw new AverriDeclarationError(
          construct,
          null,
          optionPath,
          `an operator form takes exactly one of { in, not, lt, lte, gt, gte }, got keys ${JSON.stringify(keys)}`,
        );
      }
      const op = operatorKeys[0] as WhereOperatorKey;
      out[dotted] = lowerOperatorForm(construct, `${optionPath}.${op}`, op, value[op]);
      continue;
    }
    if (keys.length === 0) {
      throw new AverriDeclarationError(construct, null, optionPath, "nested where object is empty (no fields to filter on)");
    }
    flattenInto(construct, option, value, path, out);
  }
}

function lowerOperatorForm(construct: string, option: string, op: WhereOperatorKey, operand: unknown): DbWhereValue {
  switch (op) {
    case "in": {
      if (Array.isArray(operand)) return Object.freeze({ in: lowerLitList(construct, option, operand) });
      if (isValueOperand(operand) && "ref" in operand.ast) return Object.freeze({ in: operand.ast as Ref });
      throw new AverriDeclarationError(
        construct,
        null,
        option,
        `expected an array of literals or a reference to a list field, got ${describeOperand(operand)}`,
      );
    }
    case "not": {
      const lowered = lowerWhereOperand(construct, option, operand);
      if ("op" in lowered) {
        throw new AverriDeclarationError(construct, null, option, "{ not } takes a reference or a literal, not e.len()");
      }
      return Object.freeze({ not: lowered });
    }
    case "lt":
      return Object.freeze({ lt: lowerWhereOperand(construct, option, operand) });
    case "lte":
      return Object.freeze({ lte: lowerWhereOperand(construct, option, operand) });
    case "gt":
      return Object.freeze({ gt: lowerWhereOperand(construct, option, operand) });
    case "gte":
      return Object.freeze({ gte: lowerWhereOperand(construct, option, operand) });
  }
}

// ---------------------------------------------------------------------------
// tier derivation and reference collection (SPEC-CONTRACTS §3)
// ---------------------------------------------------------------------------

/** True if any node of the AST has an `op` starting with `db.`. */
export function containsDbOp(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsDbOp);
  if (typeof node !== "object" || node === null) return false;
  const record = node as Record<string, unknown>;
  if (typeof record.op === "string" && record.op.startsWith("db.")) return true;
  return Object.keys(record).some((key) => containsDbOp(record[key]));
}

/** Tier of a boolean AST: "predicate" if it contains a `db.*` node, else "expr". */
export function tierOfAst(ast: BoolExpr): Exclude<ContractTier, "guard"> {
  return containsDbOp(ast) ? "predicate" : "expr";
}

/** Tier of any clause value: function → "guard"; otherwise derived from the AST (never trusts the `tier` field). */
export function tierOf(clause: Clause): ContractTier {
  if (isGuard(clause)) return "guard";
  return tierOfAst(clause.ast);
}

/** Wraps an AST into the clause object with the derived tier. */
export function clauseOf(ast: BoolExpr): AnalysableClause {
  return Object.freeze({ tier: tierOfAst(ast), ast }) as AnalysableClause;
}

export function valueOf(ast: Operand): Value {
  return Object.freeze({ tier: "value", ast }) as Value;
}

export function scalarValueOf(ast: Ref | Lit | LenExpr): ScalarValue {
  return Object.freeze({ tier: "value", ast }) as ScalarValue;
}

export function refValueOf(ast: Ref): RefValue {
  return Object.freeze({ tier: "value", ast }) as RefValue;
}

export interface CollectedRef {
  ref: RefPath;
  root: RefRoot;
  /** True when the ref sits inside the `where` of an `exists`/`count` over an owned list, where `self` means the element. */
  inElementScope: boolean;
}

/** Collects every `{ ref }` of an AST (including refs inside `db.*` where clauses) with its root. */
export function collectRefs(node: unknown, inElementScope = false, out: CollectedRef[] = []): CollectedRef[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, inElementScope, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const record = node as Record<string, unknown>;
  if (typeof record.ref === "string" && Object.keys(record).length === 1) {
    const root = record.ref.split(".")[0] as RefRoot;
    out.push({ ref: record.ref as RefPath, root, inElementScope });
    return out;
  }
  const elementScoped = record.op === "exists" || record.op === "count";
  for (const key of Object.keys(record)) {
    collectRefs(record[key], inElementScope || (elementScoped && key === "where"), out);
  }
  return out;
}

/** True if the AST contains an `emitted` node. */
export function containsEmitted(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsEmitted);
  if (typeof node !== "object" || node === null) return false;
  const record = node as Record<string, unknown>;
  if (record.op === "emitted") return true;
  return Object.keys(record).some((key) => containsEmitted(record[key]));
}
