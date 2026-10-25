/** A2106 — Policy is an opaque guard; the auth matrix of the actions it protects is not derivable. */

import type { Diagnostic, NodeId, PolicyNode } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

function sortedNodes(ctx: RuleContext) {
  return [...ctx.state.nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
}

export function ruleA2106(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const n of sortedNodes(ctx)) {
    if (n.kind !== "Policy") continue;
    const p = n as PolicyNode;
    if (p.tier !== "guard") continue;
    const protectedIds = p.appliesTo.filter((id) => !id.startsWith("Exposure:")) as NodeId[];
    out.push(
      emit("A2106", {
        node: p.id,
        src: p.src,
        title: `Policy is an opaque guard; auth matrix not derivable: ${p.name}`,
        message: protectedIds.length > 0 ? `Protects ${protectedIds.length} declaration(s); their auth-matrix tests become it.todo.` : "No declaration uses this policy yet.",
        related: protectedIds.slice(0, 5),
      }),
    );
  }
  return out;
}
