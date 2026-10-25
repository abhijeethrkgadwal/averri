/**
 * A3009 — where path crosses a list relation (no quantifier in V0, D-3). Nested `e.sum`/`e.count`/
 * `db.countWhere` inside a where, and paths deeper than 3, are reported while lowering.
 */

import type { Diagnostic, NodeId } from "@averri/ir";
import { emit } from "../diagnostics.js";
import type { WhereKeySite } from "../model.js";
import { allContracts, entityByModel, offsetRange, resolvePath, type RuleContext } from "./context.js";

export function ruleA3009(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  const check = (node: NodeId, w: WhereKeySite): void => {
    const entity = entityByModel(state, w.model);
    if (!entity) return;
    const segs = w.key.split(".");
    const r = resolvePath(state, entity, segs);
    if (r.crossesListAt < 0) return;
    out.push(
      emit("A3009", {
        node,
        src: offsetRange(state, w.file, w.start, w.end),
        title: `where path crosses a list relation: ${w.model}.${w.key}`,
        message: `${segs[r.crossesListAt]} is a list relation; a dotted where key may traverse only to-one relations (no some/every/none in V0).`,
      }),
    );
  };
  for (const c of allContracts(state)) for (const w of c.whereSites) check(c.id, w);
  for (const f of state.facts) for (const w of f.subjectWhereSites) check(f.nodeId, w);
  return out;
}
