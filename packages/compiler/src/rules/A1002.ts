/** A1002 — Declaration renamed: an id disappeared since the previous build and a new id has the same run/handler symbol (tie rule: a shared symbol → no rename). */

import { renameKey, type Diagnostic, type Node, type NodeId } from "@averri/ir";
import { emit } from "../diagnostics.js";
import type { RuleContext } from "./context.js";

function keyed(nodes: Iterable<Node>): Map<string, NodeId[]> {
  const m = new Map<string, NodeId[]>();
  for (const n of nodes) {
    if (n.kind !== "Action" && n.kind !== "Query") continue;
    const k = renameKey(n);
    if (!k) continue;
    m.set(k, [...(m.get(k) ?? []), n.id]);
  }
  return m;
}

export function ruleA1002(ctx: RuleContext): Diagnostic[] {
  const prev = ctx.previous;
  if (!prev) return [];
  const out: Diagnostic[] = [];
  const before = keyed(Object.values(prev.nodes));
  const after = keyed(ctx.state.nodes.values());
  for (const [k, oldIds] of before) {
    const newIds = after.get(k);
    if (!newIds || oldIds.length !== 1 || newIds.length !== 1) continue;
    const oldId = oldIds[0] as NodeId;
    const newId = newIds[0] as NodeId;
    if (oldId === newId || ctx.state.nodes.has(oldId) || prev.nodes[newId]) continue;
    const n = ctx.state.nodes.get(newId);
    out.push(
      emit("A1002", {
        node: newId,
        src: n?.src ?? null,
        title: `Declaration renamed: ${oldId.slice(oldId.indexOf(":") + 1)} → ${newId.slice(newId.indexOf(":") + 1)}`,
        message: `${oldId} disappeared and ${newId} has the same run/handler reference; generated tests and history follow the new id.`,
        cause: [
          { node: newId, why: `same handler as the removed ${oldId}` },
        ],
      }),
    );
  }
  return out;
}
