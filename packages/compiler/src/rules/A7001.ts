/** A7001 — Extracted node below the confidence threshold (info). */

import type { Diagnostic } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

function sortedNodes(ctx: RuleContext) {
  return [...ctx.state.nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
}

export function ruleA7001(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const n of sortedNodes(ctx)) {
    const p = n.provenance;
    if (p.origin !== "extracted" || p.confidence >= 0.9) continue;
    const where = n.src ? `${n.src.file}:${n.src.range[0][0]}` : null;
    const why = p.evidence.map((e) => e.note).slice(0, 2).join("; ");
    out.push(
      emit("A7001", {
        node: n.id,
        src: n.src,
        title: `Extracted node below confidence threshold: ${n.name}`.slice(0, 80),
        message: `${where ? `Read ${where} to confirm. ` : ""}${why}`.trim(),
      }),
    );
  }
  return out;
}
