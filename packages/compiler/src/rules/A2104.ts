/** A2104 — Exposure has no declaration (boundTo: null). `suggest {id}` drafts one. */

import type { Diagnostic, ExposureNode } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

function sortedNodes(ctx: RuleContext) {
  return [...ctx.state.nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
}

export function ruleA2104(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const n of sortedNodes(ctx)) {
    if (n.kind !== "Exposure") continue;
    const x = n as ExposureNode;
    if (x.boundTo !== null) continue;
    out.push(
      emit("A2104", {
        node: x.id,
        src: x.src,
        title: `Exposure has no declaration: ${x.method} ${x.path}`,
        message: `No action()/query() declares route ${x.method} ${x.path}; \`suggest {"id": "${x.id}"}\` drafts an observe-mode declaration.`,
      }),
    );
  }
  return out;
}
