/**
 * A3006 — Zod input field drifts from the Prisma field type: an `input.<field>` compared to, or used as
 * the `where` value of, a Prisma field of an incompatible type (`z.string()` vs `Int`). Fix: patch the
 * inline Zod field to the type derived from the Prisma field (keeping `.optional()`).
 *
 * V0 subset: comparisons and `where` values in contracts and `subject.where`; writes inside `run`
 * (`data: { field: input.x }`) are not inspected, and nullability is not compared.
 */

import { walkExpr, whereLeaves, type ActionNode, type BoolExpr, type DbWhere, type Diagnostic, type EntityId, type FieldNode, type Fix, type NodeId } from "@averri/ir";
import { emit, patchFix } from "../diagnostics.js";
import type { DeclFacts, ZodFieldType } from "../model.js";
import { entityByModel, fieldCategory, resolvePath, zodCategory, type RuleContext, type TypeCategory } from "./context.js";
import { refTyping } from "./types.js";

interface Pair {
  owner: DeclFacts;
  node: NodeId;
  inputField: string;
  field: FieldNode;
}

function compatible(field: TypeCategory, input: TypeCategory): boolean {
  if (input === "unknown" || field === "unknown" || field === "json") return true;
  if (field === input) return true;
  if (field === "date" && input === "string") return true; // ISO strings are accepted for DateTime
  return false;
}

/** Zod source text for a Prisma field type, using the project's local zod name. */
export function zodTextFor(field: FieldNode, z: string): string | null {
  const t = field.type;
  if (t.kind === "enum") return `${z}.enum([${t.values.map((v) => JSON.stringify(v)).join(", ")}])`;
  if (t.kind !== "scalar") return null;
  switch (t.name) {
    case "String":
      return `${z}.string()`;
    case "Int":
      return `${z}.number().int()`;
    case "Float":
    case "Decimal":
      return `${z}.number()`;
    case "BigInt":
      return `${z}.bigint()`;
    case "Boolean":
      return `${z}.boolean()`;
    case "DateTime":
      return `${z}.coerce.date()`;
    default:
      return null;
  }
}

function wherePairs(ctx: RuleContext, owner: DeclFacts, node: NodeId, model: string, where: DbWhere, out: Pair[]): void {
  const entity: EntityId | null = entityByModel(ctx.state, model);
  if (!entity) return;
  for (const leaf of whereLeaves(where)) {
    const v = leaf.value as { ref?: string };
    if (!v.ref || !v.ref.startsWith("input.") || v.ref.split(".").length !== 2) continue;
    if (leaf.operator === "in") continue; // `in` compares against a list
    const r = resolvePath(ctx.state, entity, leaf.key.split("."));
    if (r.field) out.push({ owner, node, inputField: v.ref.slice(6), field: r.field });
  }
}

export function ruleA3006(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  const pairs: Pair[] = [];
  for (const owner of state.facts) {
    if (!owner.input?.fields) continue;
    for (const c of owner.contracts) {
      if (!c.ast || !state.nodes.has(c.id)) continue;
      walkExpr(c.ast, (n, w) => {
        if (w.path.includes("where") && !w.inWhere) return;
        const node = n as BoolExpr & { op: string };
        if ("model" in node && "where" in node && typeof node.model === "string") {
          wherePairs(ctx, owner, c.id, node.model, node.where as DbWhere, pairs);
          return;
        }
        if (["eq", "ne", "lt", "lte", "gt", "gte"].includes(node.op)) {
          const cmp = node as unknown as { lhs: { ref?: string }; rhs: { ref?: string } };
          for (const [a, b] of [
            [cmp.lhs, cmp.rhs],
            [cmp.rhs, cmp.lhs],
          ] as const) {
            if (!a.ref?.startsWith("input.") || a.ref.split(".").length !== 2 || !b.ref) continue;
            const t = refTyping(ctx, c, b.ref);
            if (t.field) pairs.push({ owner, node: c.id, inputField: a.ref.slice(6), field: t.field });
          }
        }
      });
    }
    const action = state.nodes.get(owner.nodeId) as ActionNode | undefined;
    if (action?.kind === "Action" && action.subject) {
      const ent = state.nodes.get(action.subject.entity);
      if (ent && ent.kind === "Entity") wherePairs(ctx, owner, owner.nodeId, ent.clientName, action.subject.where, pairs);
    }
  }
  const seen = new Set<string>();
  for (const p of pairs) {
    const z = p.owner.input?.fields?.get(p.inputField);
    if (!z) continue;
    const fc = fieldCategory(p.field);
    const zc = zodCategory(z);
    if (compatible(fc, zc)) continue;
    const key = `${p.owner.nodeId}|${p.inputField}|${p.field.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ctx.zodDrift.add(p.owner.nodeId);
    out.push(
      emit("A3006", {
        node: p.node,
        src: z.site ? siteRange(ctx, z) : p.owner.site.src,
        title: `Zod input field drifts from Prisma field type: input.${p.inputField} vs ${p.field.name}`,
        message: `input.${p.inputField} is ${describeZod(z)} but ${p.field.name} is ${describeField(p.field)}.`,
        cause: [
          { node: p.node, why: `compares input.${p.inputField} with ${p.field.name}` },
          { node: p.field.id, why: `${p.field.name} is ${describeField(p.field)}` },
        ],
        related: [p.field.id, p.owner.nodeId],
        fixes: fixFor(ctx, z, p.field),
      }),
    );
  }
  return out;
}

function siteRange(ctx: RuleContext, z: ZodFieldType) {
  const s = z.site as NonNullable<ZodFieldType["site"]>;
  const sf = ctx.state.ctx.sourceFile(s.file);
  if (!sf) return null;
  const a = sf.getLineAndColumnAtPos(s.start);
  const b = sf.getLineAndColumnAtPos(s.end);
  return { file: s.file, range: [[a.line, a.column - 1], [b.line, b.column - 1]] as [[number, number], [number, number]] };
}

function describeZod(z: ZodFieldType): string {
  return z.kind === "enum" ? `an enum (${(z.values ?? []).slice(0, 5).join(" | ")})` : `a ${z.kind}`;
}

function describeField(f: FieldNode): string {
  const t = f.type;
  if (t.kind === "scalar") return `${t.name}${t.list ? "[]" : ""}${f.optional ? "?" : ""}`;
  if (t.kind === "enum") return `enum ${t.name}`;
  if (t.kind === "relation") return `a relation to ${t.to.slice(7)}`;
  return `Unsupported(${t.raw})`;
}

function fixFor(ctx: RuleContext, z: ZodFieldType, field: FieldNode): Fix[] {
  if (!z.site || !z.site.file) return [];
  const text = ctx.state.text(z.site.file);
  if (text === null) return [];
  const root = /^\s*([A-Za-z_$][\w$]*)\./.exec(z.site.text)?.[1] ?? "z";
  const base = zodTextFor(field, root);
  if (!base) return [];
  const replacement = `${base}${z.optional ? ".optional()" : ""}`;
  const fix = patchFix(`Derive the Zod type from ${field.name}`, `${field.name} is ${describeField(field)} in schema.prisma`, z.site.file, text, [
    { start: z.site.start, end: z.site.end, text: replacement },
  ]);
  return fix ? [fix] : [];
}
