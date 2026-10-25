/**
 * A4005 — Integration called inside a Averri-owned transaction: a declared `integration` client with
 * `nonTransactional: true` is called inside `run` of a declared-mode action with `transaction !== false`.
 */

import type { ActionNode, Diagnostic, IntegrationNode } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { rangeOf } from "../util.js";
import type { RuleContext } from "./context.js";

export function ruleA4005(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const f of state.facts) {
    const n = state.nodes.get(f.nodeId);
    if (!n || n.kind !== "Action") continue;
    const a = n as ActionNode;
    if (a.mode !== "declared" || !a.transaction) continue;
    const scan = ctx.verify.scans.get(a.id);
    if (!scan) continue;
    const seen = new Set<string>();
    for (const call of scan.integrationCalls) {
      const integ = state.nodes.get(call.integration) as IntegrationNode | undefined;
      if (!integ || !integ.nonTransactional || seen.has(integ.id)) continue;
      seen.add(integ.id);
      out.push(
        emit("A4005", {
          node: a.id,
          src: rangeOf(state.rel(call.node.getSourceFile()), call.node),
          title: `Integration ${integ.name} called inside a Averri-owned transaction`,
          message: `${a.name} runs in an interactive transaction (transaction !== false); ${integ.name} is nonTransactional, so a rollback cannot undo the foreign call. Move the call after commit (emit an event) or set transaction: false.`,
          cause: [
            { node: a.id, why: "run executes inside the action's transaction" },
            { node: integ.id, why: "declared nonTransactional" },
          ],
          related: [integ.id],
        }),
      );
    }
  }
  return out;
}
