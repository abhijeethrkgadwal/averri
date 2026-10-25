/**
 * A4002 — Declared effects differ from verified effects (SPEC-IR §3.1 rule 6). With `complete: true`
 * it fires when `declared ≠ V` and the fix patches `effects` to V; with `complete: false` only when
 * `V ⊄ declared` (info) and the fix only adds. Observe-mode declarations without a handler are reported
 * once at info: nothing could be scanned.
 */

import { Node } from "ts-morph";
import { EFFECTS, type ActionNode, type Diagnostic, type Effect, type Fix } from "@averri/ir";
import { emit, patchFix } from "../diagnostics.js";
import { unwrapExpr } from "../lower/literal.js";
import type { DeclFacts } from "../model.js";
import { rangeOf } from "../util.js";
import { verifiedEffects } from "../verify/index.js";
import type { RuleContext } from "./context.js";

function ordered(effects: Iterable<Effect>): Effect[] {
  const s = new Set(effects);
  return EFFECTS.filter((e) => s.has(e));
}

function effectsFix(ctx: RuleContext, f: DeclFacts, next: Effect[], evidence: string): Fix | null {
  const p = f.props.get("effects");
  if (!p) return null;
  const arr = unwrapExpr(p.value);
  if (!Node.isArrayLiteralExpression(arr)) return null;
  const text = ctx.state.text(f.site.file);
  if (text === null) return null;
  const first = arr.getElements()[0];
  const quote = first && Node.isStringLiteral(first) ? (first.getText()[0] as string) : '"';
  const replacement = `[${next.map((e) => `${quote}${e}${quote}`).join(", ")}]`;
  return patchFix(`Set effects to [${next.join(", ")}]`, evidence, f.site.file, text, [{ start: arr.getStart(), end: arr.getEnd(), text: replacement }]);
}

export function ruleA4002(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const f of state.facts) {
    const n = state.nodes.get(f.nodeId);
    if (!n || n.kind !== "Action") continue;
    const a = n as ActionNode;
    const effectsProp = f.props.get("effects");
    const src = effectsProp ? rangeOf(f.site.file, effectsProp.prop) : a.src;
    const scan = ctx.verify.scans.get(a.id);
    if (!scan) {
      if (a.mode === "observe" && !f.body) {
        out.push(
          emit("A4002", {
            severity: "info",
            node: a.id,
            src,
            title: `Declared effects are unverified: ${a.name} has no handler to scan`,
            message: `Observe mode without handler: effects [${a.effects.declared.join(", ")}] are taken as declared (effects.verified.complete = false). Add handler: <fn> to let effect-scan verify them.`,
          }),
        );
      }
      continue;
    }
    const v = verifiedEffects(scan);
    const declared = new Set(a.effects.declared);
    const evidence = scan.evidence.slice(0, 3).map((e) => e.note).join("; ") || "no Prisma, emit or integration calls in the body";
    if (scan.complete) {
      const same = v.size === declared.size && [...v].every((x) => declared.has(x));
      if (same) continue;
      const missing = ordered([...v].filter((x) => !declared.has(x)));
      const extra = ordered([...declared].filter((x) => !v.has(x)));
      const fix = effectsFix(ctx, f, ordered(v), `effect-scan read the whole body: ${evidence}`);
      out.push(
        emit("A4002", {
          node: a.id,
          src,
          title: `Declared effects differ from verified effects: ${a.name}`,
          message: `${missing.length ? `missing ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `not found in the body: ${extra.join(", ")}` : ""}.`,
          fixes: fix ? [fix] : [],
        }),
      );
    } else {
      const missing = ordered([...v].filter((x) => !declared.has(x)));
      if (missing.length === 0) continue;
      const fix = effectsFix(ctx, f, ordered([...declared, ...v]), `effect-scan found ${evidence} (scan incomplete: ${scan.incompleteReasons.join("; ")}; effects are only added)`);
      out.push(
        emit("A4002", {
          severity: "info",
          node: a.id,
          src,
          title: `Declared effects miss verified effects: ${a.name}`,
          message: `missing ${missing.join(", ")}; the scan was incomplete (${scan.incompleteReasons.join("; ")}), so nothing is removed.`,
          fixes: fix ? [fix] : [],
        }),
      );
    }
  }
  return out;
}
