/** A4004 — Query handler writes to the database. */

import type { Diagnostic, QueryNode } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

function sortedNodes(ctx: RuleContext) {
  return [...ctx.state.nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
}

export function ruleA4004(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const n of sortedNodes(ctx)) {
    if (n.kind !== "Query") continue;
    const q = n as QueryNode;
    const scan = ctx.verify.scans.get(q.id);
    if (!scan || scan.writes.size === 0) continue;
    const writes = [...scan.writes].sort(compareStrings);
    const ev = scan.evidence.find((e) => /\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany) at /.test(e.note));
    out.push(
      emit("A4004", {
        node: q.id,
        src: ev?.src ?? q.src,
        title: `Query handler writes to the database: ${q.name}`,
        message: `effect-scan found writes to ${writes.map((w) => w.slice("Entity:".length)).join(", ")}${ev ? ` (${ev.note})` : ""}; declare an action() instead.`,
        related: writes.slice(0, 5),
      }),
    );
  }
  return out;
}
