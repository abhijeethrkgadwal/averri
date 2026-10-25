/**
 * A3003 — Reference root or form not allowed in this phase (SPEC-CONTRACTS §2): `result` in requires,
 * `self` in a policy, `old` outside ensures, anything but the row in an invariant, and `e.emitted`
 * outside ensures.
 */

import { walkExpr, type ContractPhase, type Diagnostic, type RefRoot } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { allContracts, misspelledRoot, offsetRange, type RuleContext } from "./context.js";

export const PHASE_ROOTS: Readonly<Record<ContractPhase, readonly RefRoot[]>> = {
  requires: ["input", "actor", "self"],
  ensures: ["input", "actor", "self", "old", "result"],
  invariant: ["self"],
  allow: ["input", "actor"],
};

export function ruleA3003(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const c of allContracts(ctx.state)) {
    const allowed = PHASE_ROOTS[c.phase];
    const reported = new Set<string>();
    for (const s of c.sites) {
      if (s.inElement) continue;
      if (s.kind === "lhs" && misspelledRoot(s.raw)) continue;
      const root = s.ref.split(".")[0] as RefRoot;
      if (allowed.includes(root) || reported.has(root)) continue;
      reported.add(root);
      out.push(
        emit("A3003", {
          node: c.id,
          src: offsetRange(ctx.state, s.file, s.start, s.end),
          title: `Reference root not allowed in ${c.phase}: ${s.ref}`,
          message: `${c.phase} clauses may reference ${allowed.join(", ")}; ${root}.* is not available there${root === "self" && c.phase === "allow" ? " (policies have no subject)" : ""}.`,
        }),
      );
    }
    if (c.ast && c.phase !== "ensures") {
      let found = false;
      walkExpr(c.ast, (n) => {
        if (!found && "op" in n && n.op === "emitted") found = true;
      });
      if (found) {
        out.push(
          emit("A3003", {
            node: c.id,
            src: c.src,
            title: `e.emitted is only allowed in ensures (found in ${c.phase})`,
          }),
        );
      }
    }
  }
  return out;
}
