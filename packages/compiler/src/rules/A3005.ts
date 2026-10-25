/**
 * A3005 — Guard could be an expression or predicate (SPEC-CONTRACTS §6): the guard body is a single
 * return of a comparison over input/actor/self fields, or a single `prisma.<model>.count/findFirst`
 * call with a literal where. The suggested `e.*`/`db.*` text goes into `message`, never into a fix.
 */

import { Node, SyntaxKind } from "ts-morph";
import type { Diagnostic } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { evalLiteral, unwrapExpr } from "../lower/literal.js";
import { allContracts, type RuleContext } from "./context.js";

const CMP: Record<number, string> = {
  [SyntaxKind.EqualsEqualsEqualsToken]: "eq",
  [SyntaxKind.EqualsEqualsToken]: "eq",
  [SyntaxKind.ExclamationEqualsEqualsToken]: "ne",
  [SyntaxKind.ExclamationEqualsToken]: "ne",
  [SyntaxKind.LessThanToken]: "lt",
  [SyntaxKind.LessThanEqualsToken]: "lte",
  [SyntaxKind.GreaterThanToken]: "gt",
  [SyntaxKind.GreaterThanEqualsToken]: "gte",
};

/** The single returned expression of a function, or null. */
function singleReturn(fn: Node): Node | null {
  if (Node.isArrowFunction(fn)) {
    const body = fn.getBody();
    if (!Node.isBlock(body)) return unwrapExpr(body);
  }
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    const body = fn.getBody();
    if (body && Node.isBlock(body)) {
      const stmts = body.getStatements();
      if (stmts.length === 1 && Node.isReturnStatement(stmts[0])) {
        const e = (stmts[0] as import("ts-morph").ReturnStatement).getExpression();
        return e ? unwrapExpr(e) : null;
      }
    }
  }
  return null;
}

/** Names bound to `input`/`actor`/`self`/`prisma` by the guard's parameter (destructured or `ctx.x`). */
function bindings(fn: Node): { roots: Map<string, string>; ctx: string | null } {
  const roots = new Map<string, string>();
  let ctx: string | null = null;
  if (!(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn))) return { roots, ctx };
  const p = fn.getParameters()[0];
  if (!p) return { roots, ctx };
  const nn = p.getNameNode();
  if (Node.isIdentifier(nn)) ctx = nn.getText();
  else if (Node.isObjectBindingPattern(nn)) {
    for (const el of nn.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
      if (["input", "actor", "self", "prisma"].includes(prop)) roots.set(el.getName(), prop);
    }
  }
  return { roots, ctx };
}

/** `input.email` / `ctx.input.email` → "input.email" (one field level), else null. */
function refPath(e: Node, b: ReturnType<typeof bindings>): string | null {
  const u = unwrapExpr(e);
  if (!Node.isPropertyAccessExpression(u)) return null;
  const obj = unwrapExpr(u.getExpression());
  if (Node.isIdentifier(obj)) {
    const root = b.roots.get(obj.getText());
    if (root && root !== "prisma") return `${root}.${u.getName()}`;
  }
  if (Node.isPropertyAccessExpression(obj) && b.ctx) {
    const base = unwrapExpr(obj.getExpression());
    if (Node.isIdentifier(base) && base.getText() === b.ctx && ["input", "actor", "self"].includes(obj.getName())) return `${obj.getName()}.${u.getName()}`;
  }
  return null;
}

function operandText(e: Node, b: ReturnType<typeof bindings>, rhs: boolean): string | null {
  const r = refPath(e, b);
  if (r) return rhs ? `e.${r.split(".")[0]}(${JSON.stringify(r.slice(r.indexOf(".") + 1))})` : JSON.stringify(r);
  const l = evalLiteral(e);
  if (l.ok && (l.value === null || ["string", "number", "boolean"].includes(typeof l.value))) return JSON.stringify(l.value);
  return null;
}

function isPrisma(e: Node, b: ReturnType<typeof bindings>): boolean {
  const u = unwrapExpr(e);
  if (Node.isIdentifier(u)) return b.roots.get(u.getText()) === "prisma";
  if (Node.isPropertyAccessExpression(u) && b.ctx) {
    const base = unwrapExpr(u.getExpression());
    return Node.isIdentifier(base) && base.getText() === b.ctx && u.getName() === "prisma";
  }
  return false;
}

/** `prisma.<model>.count|findFirst({ where: {...} })` → `{ model, whereText }`. */
function prismaCall(e: Node, b: ReturnType<typeof bindings>): { model: string; op: string; whereText: string } | null {
  const u = unwrapExpr(e);
  if (!Node.isCallExpression(u)) return null;
  const callee = unwrapExpr(u.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const op = callee.getName();
  if (op !== "count" && op !== "findFirst") return null;
  const acc = unwrapExpr(callee.getExpression());
  if (!Node.isPropertyAccessExpression(acc) || !isPrisma(acc.getExpression(), b)) return null;
  const arg = u.getArguments()[0];
  const obj = arg ? unwrapExpr(arg) : undefined;
  if (!obj || !Node.isObjectLiteralExpression(obj)) return null;
  const wp = obj.getProperty("where");
  if (!wp || !Node.isPropertyAssignment(wp)) return null;
  const w = unwrapExpr(wp.getInitializer() as Node);
  if (!Node.isObjectLiteralExpression(w)) return null;
  const parts: string[] = [];
  for (const p of w.getProperties()) {
    if (!Node.isPropertyAssignment(p)) return null;
    const v = operandText(p.getInitializer() as Node, b, true);
    if (v === null) return null;
    parts.push(`${p.getName()}: ${v}`);
  }
  return { model: acc.getName(), op, whereText: `{ ${parts.join(", ")} }` };
}

/** The suggested tier 1/2 replacement text for a guard body, or null. */
export function suggestReplacement(fn: Node): string | null {
  const ret = singleReturn(fn);
  if (!ret) return null;
  const b = bindings(fn);
  const body = Node.isAwaitExpression(ret) ? unwrapExpr(ret.getExpression()) : ret;
  if (Node.isBinaryExpression(body)) {
    const op = CMP[body.getOperatorToken().getKind()];
    if (op) {
      const lp = prismaCall(Node.isAwaitExpression(body.getLeft()) ? (body.getLeft() as import("ts-morph").AwaitExpression).getExpression() : body.getLeft(), b);
      if (lp && lp.op === "count") {
        const lit = evalLiteral(body.getRight());
        if (lit.ok && typeof lit.value === "number") {
          if ((op === "gt" && lit.value === 0) || (op === "gte" && lit.value === 1) || (op === "ne" && lit.value === 0)) return `db.exists("${lp.model}", ${lp.whereText})`;
          if (op === "eq" && lit.value === 0) return `db.none("${lp.model}", ${lp.whereText})`;
          if (op === "eq" && lit.value === 1) return `db.unique("${lp.model}", ${lp.whereText})`;
        }
      }
      if (lp && lp.op === "findFirst" && op === "ne") {
        const lit = evalLiteral(body.getRight());
        if (lit.ok && lit.value === null) return `db.exists("${lp.model}", ${lp.whereText})`;
      }
      const lhs = refPath(body.getLeft(), b);
      const rhs = operandText(body.getRight(), b, true);
      if (lhs && rhs) return `e.${op}(${JSON.stringify(lhs)}, ${rhs})`;
    }
  }
  if (Node.isPrefixUnaryExpression(body) && body.getOperatorToken() === SyntaxKind.ExclamationToken) {
    const inner = unwrapExpr(body.getOperand());
    if (Node.isPrefixUnaryExpression(inner) && inner.getOperatorToken() === SyntaxKind.ExclamationToken) {
      const operand = unwrapExpr(inner.getOperand());
      const pc = prismaCall(Node.isAwaitExpression(operand) ? operand.getExpression() : operand, b);
      if (pc && pc.op === "findFirst") return `db.exists("${pc.model}", ${pc.whereText})`;
    }
  }
  return null;
}

export function ruleA3005(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const c of allContracts(ctx.state)) {
    if (c.tier !== "guard" || !c.guard) continue;
    const suggestion = suggestReplacement(c.guard);
    if (!suggestion) continue;
    out.push(
      emit("A3005", {
        node: c.id,
        src: c.src,
        title: `Guard could be an expression or predicate: ${c.clause}`,
        message: `Replace the guard with ${suggestion} so it is serialised, tested and visible to impact.`,
      }),
    );
  }
  return out;
}
