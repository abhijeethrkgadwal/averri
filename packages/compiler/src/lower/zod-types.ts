/**
 * Zod field names and types from the TypeChecker type of `z.output<typeof schema>` (D-2): the
 * schema is never evaluated. Works through `.extend/.merge/.pick`, imported schemas and spreads,
 * because the checker resolves them. A syntactic fallback reads inline `z.object({...})` literals when
 * the checker cannot (zod not resolvable from the project).
 */

import { Node, ts, type Type } from "ts-morph";
import type { ZodFieldType, ZodScalarKind } from "../model.js";
import { propertyKey, unwrapExpr } from "./literal.js";

/** Field types of an object schema's output, or null when the expression is not an object schema. */
export function zodOutputFields(expr: Node): { fields: Map<string, ZodFieldType>; method: "checker" | "ast" } | null {
  const checked = viaChecker(expr);
  const ast = viaAst(expr);
  if (checked) {
    if (ast) for (const [k, v] of ast) if (v.site && checked.has(k)) (checked.get(k) as ZodFieldType).site = v.site;
    // Prefer source order (the checker may reorder properties).
    const ordered = new Map<string, ZodFieldType>();
    if (ast) for (const k of ast.keys()) if (checked.has(k)) ordered.set(k, checked.get(k) as ZodFieldType);
    for (const [k, v] of checked) if (!ordered.has(k)) ordered.set(k, v);
    return { fields: ordered, method: "checker" };
  }
  return ast ? { fields: ast, method: "ast" } : null;
}

function viaChecker(expr: Node): Map<string, ZodFieldType> | null {
  try {
    const t = expr.getType();
    const zodProp = t.getProperty("_zod");
    if (!zodProp) return null;
    const zt = zodProp.getTypeAtLocation(expr);
    const outProp = zt.getProperty("output");
    if (!outProp) return null;
    const out = outProp.getTypeAtLocation(expr);
    if (!out.isObject() || out.isArray()) return null;
    const props = out.getProperties();
    if (props.length === 0 && !out.getText().startsWith("{")) return null;
    const fields = new Map<string, ZodFieldType>();
    for (const p of props) {
      const pt = p.getTypeAtLocation(expr);
      const ft = classify(pt);
      if (p.isOptional()) ft.optional = true;
      fields.set(p.getName(), ft);
    }
    return fields;
  } catch {
    return null;
  }
}

function hasFlag(t: Type, flag: ts.TypeFlags): boolean {
  return (t.getFlags() & flag) !== 0;
}

/** Classify a TS type into the coarse kinds A3006/A3008 compare. */
export function classify(t: Type): ZodFieldType {
  let nullable = false;
  let optional = false;
  let members = t.isUnion() ? t.getUnionTypes() : [t];
  const kept: Type[] = [];
  for (const m of members) {
    if (m.isNull()) nullable = true;
    else if (m.isUndefined() || hasFlag(m, ts.TypeFlags.Void)) optional = true;
    else kept.push(m);
  }
  members = kept;
  if (members.length === 0) return { kind: "unknown", nullable, optional };
  if (members.every((m) => m.isBooleanLiteral() || m.isBoolean())) return { kind: "boolean", nullable, optional };
  if (members.every((m) => m.isStringLiteral())) {
    return { kind: "enum", values: members.map((m) => String(m.getLiteralValue())), nullable, optional };
  }
  if (members.length === 1) {
    const m = members[0] as Type;
    return { kind: kindOf(m), nullable, optional };
  }
  const kinds = new Set(members.map(kindOf));
  if (kinds.size === 1) return { kind: [...kinds][0] as ZodScalarKind, nullable, optional };
  return { kind: "unknown", nullable, optional };
}

function kindOf(m: Type): ZodScalarKind {
  if (m.isString() || m.isStringLiteral() || m.isTemplateLiteral()) return "string";
  if (m.isNumber() || m.isNumberLiteral()) return "number";
  if (m.isBoolean() || m.isBooleanLiteral()) return "boolean";
  if (hasFlag(m, ts.TypeFlags.BigInt) || hasFlag(m, ts.TypeFlags.BigIntLiteral)) return "bigint";
  if (m.isArray()) return "array";
  const sym = m.getSymbol();
  if (sym && sym.getName() === "Date") return "date";
  if (m.isAny() || m.isUnknown()) return "unknown";
  if (m.isObject()) return "object";
  return "unknown";
}

// ---------------------------------------------------------------------------
// syntactic fallback
// ---------------------------------------------------------------------------

const AST_KINDS: Record<string, ZodScalarKind> = {
  string: "string",
  email: "string",
  uuid: "string",
  cuid: "string",
  url: "string",
  number: "number",
  int: "number",
  boolean: "boolean",
  date: "date",
  bigint: "bigint",
  enum: "enum",
  literal: "enum",
  array: "array",
  object: "object",
  datetime: "string",
};

function viaAst(expr: Node): Map<string, ZodFieldType> | null {
  const u = unwrapExpr(expr);
  if (!Node.isCallExpression(u)) return null;
  const callee = unwrapExpr(u.getExpression());
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "object") return null;
  const arg = u.getArguments()[0];
  if (!arg) return null;
  const obj = unwrapExpr(arg);
  if (!Node.isObjectLiteralExpression(obj)) return null;
  const fields = new Map<string, ZodFieldType>();
  for (const p of obj.getProperties()) {
    if (!Node.isPropertyAssignment(p)) continue;
    const key = propertyKey(p);
    const init = p.getInitializer();
    if (key === null || !init) continue;
    const ft = classifyChain(init);
    ft.site = { file: "", start: init.getStart(), end: init.getEnd(), text: init.getText() };
    fields.set(key, ft);
  }
  return fields;
}

/** Root method and modifiers of a `z.string().email().optional()` chain. */
export function classifyChain(init: Node): ZodFieldType {
  const ft: ZodFieldType = { kind: "unknown", nullable: false, optional: false };
  let cur: Node = unwrapExpr(init);
  while (Node.isCallExpression(cur)) {
    const callee = unwrapExpr(cur.getExpression());
    if (!Node.isPropertyAccessExpression(callee)) break;
    const name = callee.getName();
    if (name === "optional" || name === "default") ft.optional = ft.optional || name === "optional";
    else if (name === "nullable") ft.nullable = true;
    else if (name === "nullish") {
      ft.nullable = true;
      ft.optional = true;
    }
    const recv = unwrapExpr(callee.getExpression());
    const isRoot = Node.isIdentifier(recv) || (Node.isPropertyAccessExpression(recv) && Node.isIdentifier(unwrapExpr(recv.getExpression())));
    if (isRoot && AST_KINDS[name] !== undefined) {
      ft.kind = AST_KINDS[name] as ZodScalarKind;
      if (name === "enum" || name === "literal") {
        const a = cur.getArguments()[0];
        const ua = a ? unwrapExpr(a) : undefined;
        if (ua && Node.isArrayLiteralExpression(ua)) {
          ft.values = ua.getElements().map((el) => (Node.isStringLiteral(el) ? el.getLiteralText() : el.getText()));
        } else if (ua && Node.isStringLiteral(ua)) ft.values = [ua.getLiteralText()];
        else if (ua && (Node.isNumericLiteral(ua) || Node.isTrueLiteral(ua) || Node.isFalseLiteral(ua))) {
          ft.kind = Node.isNumericLiteral(ua) ? "number" : "boolean";
        }
      }
      break;
    }
    cur = recv;
  }
  return ft;
}
