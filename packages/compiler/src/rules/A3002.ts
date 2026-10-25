/**
 * A3002 — Contract references unknown field: a ref path or `where` key that is not a field of the
 * resolved entity/schema, or a doubled root (`e.input("input.x")`). Fields are checked against the
 * Prisma schema facts for `self`/`old`/`result` (entity outputs) and `where` keys, and against the Zod
 * output type for `input` and Zod `result` outputs. `actor` is not checked (no augmentation facts).
 *
 * Fix, in order: the field was renamed since the last green build (one new field on the entity) →
 * patch to the new name; else a unique case-insensitive match → patch; doubled root → strip it.
 */

import { fieldId, type Diagnostic, type EntityId, type Fix, type Graph, type NodeId } from "@averri/ir";
import { emit, patchFix } from "../diagnostics.js";
import type { ContractFacts, RefSite, WhereKeySite } from "../model.js";
import type { BuildState } from "../state.js";
import { allContracts, entityByModel, fieldsOf, misspelledRoot, offsetRange, resolvePath, rootEntity, type RuleContext } from "./context.js";

/** The replacement for a missing field name, with the evidence sentence, or null. */
export function fieldSuggestion(state: BuildState, lastGreen: Graph | null, entity: EntityId, missing: string): { name: string; evidence: string } | null {
  const current = fieldsOf(state, entity).map((f) => f.name.slice(f.name.indexOf(".") + 1));
  if (lastGreen && lastGreen.nodes[fieldId(entity, missing)]) {
    const before = new Set(Object.values(lastGreen.nodes).filter((n) => n.kind === "Field" && n.id.startsWith(`Field:${entity.slice("Entity:".length)}.`)).map((n) => n.id));
    const added = current.filter((name) => !before.has(fieldId(entity, name)));
    if (added.length === 1) return { name: added[0] as string, evidence: `${entity.slice(7)}.${missing} was renamed to ${added[0]} since the last green build` };
  }
  const ci = current.filter((name) => name.toLowerCase() === missing.toLowerCase());
  if (ci.length === 1) return { name: ci[0] as string, evidence: `${ci[0]} is the only field of ${entity.slice(7)} matching "${missing}" case-insensitively` };
  return null;
}

/** Patch a ref site so that ref segment `index` (0 = root) becomes `replacement`. */
function siteFix(state: BuildState, site: RefSite, index: number, replacement: string, label: string, evidence: string): Fix | null {
  const text = state.text(site.file);
  if (text === null) return null;
  const refSegs = site.ref.split(".");
  const rawSegs = site.raw.split(".");
  const offset = refSegs.length - rawSegs.length;
  const i = index - offset;
  if (i < 0 || i >= rawSegs.length) return null;
  rawSegs[i] = replacement;
  const literal = text.slice(site.start, site.end);
  const quote = literal[0] as string;
  return patchFix(label, evidence, site.file, text, [{ start: site.start, end: site.end, text: `${quote}${rawSegs.join(".")}${quote}` }]);
}

function stripDoubled(state: BuildState, site: RefSite): Fix | null {
  const text = state.text(site.file);
  if (text === null) return null;
  const rawSegs = site.raw.split(".");
  const literal = text.slice(site.start, site.end);
  const quote = literal[0] as string;
  return patchFix("Strip the duplicate root", `e.${rawSegs[0]}() already supplies the ${rawSegs[0]} root`, site.file, text, [
    { start: site.start, end: site.end, text: `${quote}${rawSegs.slice(1).join(".")}${quote}` },
  ]);
}

export function ruleA3002(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const c of allContracts(state)) {
    const owner = state.factsById.get(c.owner);
    for (const s of c.sites) {
      if (s.inElement) continue;
      if (s.kind === "lhs" && misspelledRoot(s.raw)) continue;
      const segs = s.ref.split(".");
      const root = segs[0] as string;
      // doubled root: e.input("input.teamId")
      if (s.kind === "rooted" && segs[1] === root) {
        const fix = stripDoubled(state, s);
        if (root === "input" && owner) ctx.zodDrift.add(owner.nodeId);
        out.push(
          emit("A3002", {
            node: c.id,
            src: offsetRange(state, s.file, s.start, s.end),
            title: `Contract references unknown field: doubled root in e.${root}("${s.raw}")`,
            message: `e.${root}("${s.raw}") denotes ${s.ref}; the builder does not strip a repeated root.`,
            fixes: fix ? [fix] : [],
          }),
        );
        continue;
      }
      if (root === "self" || root === "old" || root === "result") {
        const entity = rootEntity(state, c, root);
        if (entity) {
          const r = resolvePath(state, entity, segs.slice(1));
          if (r.failedAt >= 0 && r.entityAt && r.crossesListAt < 0) {
            out.push(missingField(ctx, c, s, r.entityAt, segs[r.failedAt + 1] as string, r.failedAt + 1));
          }
          continue;
        }
        if (root === "result" && owner?.outputFields) {
          const name = segs[1] as string;
          if (!owner.outputFields.has(name)) {
            out.push(
              emit("A3002", {
                node: c.id,
                src: offsetRange(state, s.file, s.start, s.end),
                title: `Contract references unknown field: ${s.ref}`,
                message: `The output schema has no field ${name} (fields: ${[...owner.outputFields.keys()].slice(0, 12).join(", ")}).`,
              }),
            );
          }
        }
        continue;
      }
      if (root === "input" && owner?.input?.fields && owner.input.complete) {
        const name = segs[1] as string;
        if (!owner.input.fields.has(name)) {
          ctx.zodDrift.add(owner.nodeId);
          const keys = [...owner.input.fields.keys()];
          const ci = keys.filter((k) => k.toLowerCase() === name.toLowerCase());
          const fixes: Fix[] = [];
          if (ci.length === 1) {
            const fix = siteFix(state, s, 1, ci[0] as string, `Use input.${ci[0]}`, `${ci[0]} is the only input field matching "${name}" case-insensitively`);
            if (fix) fixes.push(fix);
          }
          out.push(
            emit("A3002", {
              node: c.id,
              src: offsetRange(state, s.file, s.start, s.end),
              title: `Contract references unknown field: ${s.ref}`,
              message: `The input schema has no field ${name} (fields: ${keys.slice(0, 12).join(", ")}).`,
              fixes,
            }),
          );
        }
      }
    }
    for (const w of c.whereSites) checkWhere(ctx, c.id, w, out);
  }
  for (const f of state.facts) for (const w of f.subjectWhereSites) checkWhere(ctx, f.nodeId, w, out);
  return out;
}

function checkWhere(ctx: RuleContext, node: NodeId, w: WhereKeySite, out: Diagnostic[]): void {
  const state = ctx.state;
  {
      const entity = entityByModel(state, w.model);
      if (!entity) return;
      const segs = w.key.split(".");
      const r = resolvePath(state, entity, segs);
      if (r.failedAt < 0 || !r.entityAt || r.crossesListAt >= 0) return;
      const missing = segs[r.failedAt] as string;
      const sug = fieldSuggestion(state, ctx.lastGreen, r.entityAt, missing);
      const fixes: Fix[] = [];
      const text = state.text(w.file);
      if (sug && text !== null && r.failedAt === segs.length - 1) {
        const keyText = text.slice(w.start, w.end);
        const quoted = /^["']/.test(keyText);
        const inner = quoted ? keyText.slice(1, -1) : keyText;
        const innerSegs = inner.split(".");
        innerSegs[innerSegs.length - 1] = sug.name;
        const replacement = quoted ? `${keyText[0]}${innerSegs.join(".")}${keyText[0]}` : innerSegs.join(".");
        const fix = patchFix(`Use ${sug.name}`, sug.evidence, w.file, text, [{ start: w.start, end: w.end, text: replacement }]);
        if (fix) fixes.push(fix);
      }
      out.push(
        emit("A3002", {
          node,
          src: offsetRange(state, w.file, w.start, w.end),
          title: `Contract references unknown field: ${w.model}.${w.key}`,
          message: `${r.entityAt.slice(7)} has no field ${missing}.`,
          fixes,
          related: [r.entityAt],
        }),
      );
  }
}

function missingField(ctx: RuleContext, c: ContractFacts, s: RefSite, entity: EntityId, missing: string, index: number): Diagnostic {
  const state = ctx.state;
  const sug = fieldSuggestion(state, ctx.lastGreen, entity, missing);
  const fixes: Fix[] = [];
  if (sug) {
    const fix = siteFix(state, s, index, sug.name, `Use ${sug.name}`, sug.evidence);
    if (fix) fixes.push(fix);
  }
  const names = fieldsOf(state, entity).map((f) => f.name.slice(f.name.indexOf(".") + 1));
  return emit("A3002", {
    node: c.id,
    src: offsetRange(state, s.file, s.start, s.end),
    title: `Contract references unknown field: ${s.ref}`,
    message: `${entity.slice(7)} has no field ${missing} (fields: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", ..." : ""}).`,
    fixes,
    related: [entity],
  });
}
