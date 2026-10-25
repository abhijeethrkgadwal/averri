/** A1005 — Declaration keys out of canonical order (SPEC-DECLARATIONS §4; `averri fmt` is check-only in V0, D-22). */

import type { Diagnostic } from "@averri/ir";
import { emit } from "../diagnostics.js";
import type { Construct } from "../lower/core-imports.js";
import { rangeOf } from "../util.js";
import type { RuleContext } from "./context.js";

/**
 * Canonical key order per construct. action/query are normative (SPEC-DECLARATIONS §4); the others
 * follow @averri/core's `CANONICAL_KEY_ORDERS` convention (D-35c), copied as data (the compiler does not
 * import core, D-2). `policy|public` and `run|handler` share one slot each.
 */
export const CANONICAL_KEY_ORDERS: Readonly<Record<Construct, readonly string[]>> = {
  entity: ["intent", "invariant", "owner", "tags"],
  policy: ["intent", "allow", "owner", "tags"],
  event: ["intent", "payload", "external", "owner", "tags"],
  action: ["intent", "route", "input", "output", "policy|public", "subject", "requires", "ensures", "effects", "idempotency", "transaction", "run|handler", "owner", "tags"],
  query: ["intent", "route", "input", "output", "policy|public", "run|handler", "owner", "tags"],
  workflow: ["intent", "on", "runner", "engine", "retry", "owner", "tags"],
  integration: ["intent", "client", "webhook", "idempotency", "nonTransactional", "effects", "owner", "tags"],
};

function slotOf(order: readonly string[], key: string): number {
  return order.findIndex((slot) => slot.split("|").includes(key));
}

export function ruleA1005(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const f of ctx.state.facts) {
    // Only the action/query order is normative (SPEC-DECLARATIONS §4); the other constructs follow core's convention (D-35c) and are not checked.
    if (f.site.construct !== "action" && f.site.construct !== "query") continue;
    const order = CANONICAL_KEY_ORDERS[f.site.construct];
    let last = -1;
    let lastKey = "";
    for (const k of f.keys) {
      const slot = slotOf(order, k.key);
      if (slot < 0) continue;
      if (slot < last) {
        const expected = f.keys
          .map((x) => x.key)
          .filter((x) => slotOf(order, x) >= 0)
          .sort((a, b) => slotOf(order, a) - slotOf(order, b));
        out.push(
          emit("A1005", {
            node: f.nodeId,
            src: rangeOf(f.site.file, k.node),
            title: `Declaration keys out of canonical order: ${k.key} after ${lastKey}`,
            message: `Canonical order for ${f.site.construct}(): ${expected.join(", ")}. averri fmt is check-only in V0.`,
          }),
        );
        break;
      }
      last = slot;
      lastKey = k.key;
    }
  }
  return out;
}
