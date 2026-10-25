/** Operand typing shared by A3006 and A3008: Prisma schema facts for entity paths, Zod output types for input/result. */

import type { FieldNode, Operand } from "@averri/ir";
import type { ContractFacts } from "../model.js";
import { fieldCategory, resolvePath, rootEntity, zodCategory, type RuleContext, type TypeCategory } from "./context.js";

export type OperandCategory = TypeCategory | "datestring" | "null";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface RefTyping {
  category: OperandCategory;
  /** The Prisma field when the ref resolves to one. */
  field: FieldNode | null;
}

export function refTyping(ctx: RuleContext, c: ContractFacts, ref: string): RefTyping {
  const segs = ref.split(".");
  const root = segs[0] as string;
  const state = ctx.state;
  const owner = state.factsById.get(c.owner);
  if (root === "self" || root === "old" || root === "result") {
    const entity = rootEntity(state, c, root);
    if (entity) {
      const r = resolvePath(state, entity, segs.slice(1));
      return r.field ? { category: fieldCategory(r.field), field: r.field } : { category: "unknown", field: null };
    }
    if (root === "result" && owner?.outputFields && segs.length === 2) {
      const z = owner.outputFields.get(segs[1] as string);
      return { category: z ? zodCategory(z) : "unknown", field: null };
    }
    return { category: "unknown", field: null };
  }
  if (root === "input" && owner?.input?.fields && segs.length === 2) {
    const z = owner.input.fields.get(segs[1] as string);
    return { category: z ? zodCategory(z) : "unknown", field: null };
  }
  return { category: "unknown", field: null };
}

export function operandCategory(ctx: RuleContext, c: ContractFacts, o: Operand): OperandCategory {
  if ("lit" in o) {
    const v = o.lit;
    if (v === null) return "null";
    if (Array.isArray(v)) return "list";
    if (typeof v === "number") return "numeric";
    if (typeof v === "boolean") return "boolean";
    return ISO_DATE_RE.test(v) ? "datestring" : "string";
  }
  if ("ref" in o) return refTyping(ctx, c, o.ref).category;
  return "numeric"; // len, sum, count, db.countWhere
}

/** `lt/lte/gt/gte` applicability: both numeric, or both date-typed (an ISO date literal counts as a date). */
export function orderable(a: OperandCategory, b: OperandCategory): boolean | null {
  if (a === "unknown" || b === "unknown" || a === "json" || b === "json") return null;
  const isDate = (x: OperandCategory): boolean => x === "date" || x === "datestring";
  if (a === "numeric" && b === "numeric") return true;
  if ((a === "date" && isDate(b)) || (b === "date" && isDate(a))) return true;
  return false;
}
