/**
 * Static evaluation of plain literal values (SPEC-DECLARATIONS §4.1): string/number/boolean/null
 * literals, template literals without substitutions, array and object literals, and constant folding
 * of numeric arithmetic over literals (`30 * 24 * 60 * 60`, D-38). Nothing is ever executed.
 */

import { Node, SyntaxKind } from "ts-morph";

export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

export type LiteralResult = { ok: true; value: Literal } | { ok: false; reason: string; node: Node };

/** Strip parentheses, `as const`, `satisfies` and `!`. `as T` casts other than `as const` are kept (A1004). */
export function unwrapExpr(expr: Node): Node {
  let cur = expr;
  for (;;) {
    if (Node.isParenthesizedExpression(cur)) cur = cur.getExpression();
    else if (Node.isSatisfiesExpression(cur)) cur = cur.getExpression();
    else if (Node.isNonNullExpression(cur)) cur = cur.getExpression();
    else if (Node.isAsExpression(cur) && cur.getTypeNode()?.getText() === "const") cur = cur.getExpression();
    else return cur;
  }
}

/** Human description of an expression kind, for A1004 messages. */
export function describeExpr(node: Node): string {
  const n = unwrapExpr(node);
  if (Node.isSpreadElement(n) || Node.isSpreadAssignment(n)) return "a spread";
  if (Node.isConditionalExpression(n)) return "a conditional expression";
  if (Node.isCallExpression(n)) return `a call to ${compactCallee(n.getExpression().getText())}()`;
  if (Node.isTemplateExpression(n)) return "a template literal with substitutions";
  if (Node.isAsExpression(n)) return "an `as` cast";
  if (Node.isIdentifier(n)) return `the identifier ${n.getText()}`;
  if (Node.isPropertyAccessExpression(n)) return `the member access ${n.getText()}`;
  if (Node.isComputedPropertyName(n)) return "a computed key";
  if (Node.isBinaryExpression(n)) return `a binary expression (${n.getOperatorToken().getText()})`;
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) return "a function";
  if (Node.isNewExpression(n)) return "a `new` expression";
  return `a ${n.getKindName()}`;
}

function compactCallee(text: string): string {
  const t = text.replace(/\s+/g, "");
  return t.length > 40 ? `${t.slice(0, 37)}...` : t;
}

function numeric(n: Node): number | null {
  const u = unwrapExpr(n);
  if (Node.isNumericLiteral(u)) return u.getLiteralValue();
  if (Node.isPrefixUnaryExpression(u)) {
    const op = u.getOperatorToken();
    const v = numeric(u.getOperand());
    if (v === null) return null;
    if (op === SyntaxKind.MinusToken) return -v;
    if (op === SyntaxKind.PlusToken) return v;
    return null;
  }
  if (Node.isBinaryExpression(u)) {
    const l = numeric(u.getLeft());
    const r = numeric(u.getRight());
    if (l === null || r === null) return null;
    switch (u.getOperatorToken().getKind()) {
      case SyntaxKind.PlusToken:
        return l + r;
      case SyntaxKind.MinusToken:
        return l - r;
      case SyntaxKind.AsteriskToken:
        return l * r;
      case SyntaxKind.SlashToken:
        return r === 0 ? null : l / r;
      case SyntaxKind.PercentToken:
        return r === 0 ? null : l % r;
      case SyntaxKind.AsteriskAsteriskToken:
        return l ** r;
      default:
        return null;
    }
  }
  return null;
}

/** Evaluate a plain literal. Identifiers are not followed here (callers decide what an identifier may mean). */
export function evalLiteral(expr: Node): LiteralResult {
  const n = unwrapExpr(expr);
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return { ok: true, value: n.getLiteralText() };
  if (Node.isTrueLiteral(n)) return { ok: true, value: true };
  if (Node.isFalseLiteral(n)) return { ok: true, value: false };
  if (Node.isNullLiteral(n)) return { ok: true, value: null };
  const num = numeric(n);
  if (num !== null && Number.isFinite(num)) return { ok: true, value: num };
  if (Node.isArrayLiteralExpression(n)) {
    const out: Literal[] = [];
    for (const el of n.getElements()) {
      const r = evalLiteral(el);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (Node.isObjectLiteralExpression(n)) {
    const out: { [key: string]: Literal } = {};
    for (const p of n.getProperties()) {
      if (!Node.isPropertyAssignment(p)) return { ok: false, reason: describeExpr(p), node: p };
      const key = propertyKey(p);
      if (key === null) return { ok: false, reason: "a computed key", node: p };
      const init = p.getInitializer();
      if (!init) return { ok: false, reason: "a missing value", node: p };
      const r = evalLiteral(init);
      if (!r.ok) return r;
      out[key] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, reason: describeExpr(n), node: n };
}

/** Static key of a property assignment (identifier, string or numeric literal); null when computed. */
export function propertyKey(p: Node): string | null {
  if (!Node.isPropertyAssignment(p) && !Node.isShorthandPropertyAssignment(p) && !Node.isMethodDeclaration(p)) return null;
  const name = p.getNameNode();
  if (Node.isIdentifier(name) || Node.isPrivateIdentifier(name)) return name.getText();
  if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) return name.getLiteralText();
  if (Node.isNumericLiteral(name)) return String(name.getLiteralValue());
  return null;
}
