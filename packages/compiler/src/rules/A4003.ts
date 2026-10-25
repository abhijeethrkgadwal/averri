/** A4003 — Event has no consumer (external: false and no consumedBy edge). */

import type { Diagnostic, EventNode } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

function sortedNodes(ctx: RuleContext) {
  return [...ctx.state.nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
}

export function ruleA4003(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const consumed = new Set(ctx.state.edges.filter((e) => e.kind === "consumedBy").map((e) => e.from));
  for (const n of sortedNodes(ctx)) {
    if (n.kind !== "Event") continue;
    const ev = n as EventNode;
    if (ev.external || consumed.has(ev.id)) continue;
    const emitters = ctx.state.edges.filter((e) => e.kind === "emits" && e.to === ev.id).map((e) => e.from);
    out.push(
      emit("A4003", {
        node: ev.id,
        src: ev.src,
        title: `Event has no consumer: ${ev.name}`,
        message: "Declare a workflow({ on }) for it, or mark it external: true when it is consumed outside this repository.",
        related: emitters.slice(0, 5),
      }),
    );
  }
  return out;
}
