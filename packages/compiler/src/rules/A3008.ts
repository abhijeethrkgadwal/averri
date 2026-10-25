/**
 * A3008 — Operator not applicable to operand type: `lt/lte/gt/gte` whose operands are not both numeric
 * or both DateTime; `len` on a non-string/non-list; `sum` over a non-numeric element field.
 */

import { renderExpr, walkExpr, type Diagnostic, type Operand } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { allContracts, fieldCategory, resolvePath, rootEntity, type RuleContext } from "./context.js";
import { operandCategory, orderable, refTyping } from "./types.js";

const ORDER_OPS = new Set(["lt", "lte", "gt", "gte"]);

export function ruleA3008(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const c of allContracts(state)) {
    if (!c.ast) continue;
    const problems: string[] = [];
    walkExpr(c.ast, (n, w) => {
      if (w.inWhere || w.path.includes("where")) return; // db where operands and list-element filters are not typed here
      const node = n as unknown as { op?: string; lhs?: Operand; rhs?: Operand; arg?: { ref: string }; path?: { ref: string }; field?: string };
      if (node.op && ORDER_OPS.has(node.op) && node.lhs && node.rhs) {
        const a = operandCategory(ctx, c, node.lhs);
        const b = operandCategory(ctx, c, node.rhs);
        if (orderable(a, b) === false) problems.push(`${renderExpr(n)}: ${node.op} over ${a} and ${b}`);
      }
      if (node.op === "len" && node.arg) {
        const t = refTyping(ctx, c, node.arg.ref).category;
        if (t !== "unknown" && t !== "string" && t !== "list") problems.push(`len(${node.arg.ref}) over a ${t}`);
      }
      if (node.op === "sum" && node.path && node.field) {
        const segs = node.path.ref.split(".");
        const entity = rootEntity(state, c, segs[0] as string);
        if (entity) {
          const r = resolvePath(state, entity, segs.slice(1));
          if (r.field && r.field.type.kind === "relation") {
            const el = resolvePath(state, r.field.type.to, [node.field]);
            if (el.field && fieldCategory(el.field) !== "numeric") problems.push(`sum(${node.path.ref}, ${node.field}) over a ${fieldCategory(el.field)} field`);
          }
        }
      }
    });
    for (const p of problems.slice(0, 3)) {
      out.push(emit("A3008", { node: c.id, src: c.src, title: `Operator not applicable to operand type in ${c.clause}`, message: p }));
    }
  }
  return out;
}

