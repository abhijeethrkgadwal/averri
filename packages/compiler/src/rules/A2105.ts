/** A2105 — Exposed declared-mode action has no intent. */

import type { ActionNode, Diagnostic } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

function sortedNodes(ctx: RuleContext) {
  return [...ctx.state.nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
}

export function ruleA2105(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const n of sortedNodes(ctx)) {
    if (n.kind !== "Action") continue;
    const a = n as ActionNode;
    if (a.mode !== "declared" || !a.route || (a.intent && a.intent.trim().length > 0)) continue;
    out.push(emit("A2105", { node: a.id, src: a.src, title: `Exposed declared-mode action has no intent: ${a.name}` }));
  }
  return out;
}
