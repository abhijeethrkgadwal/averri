/** A3001 — self/old reference without a subject (actions only; invariants use self as the row). */

import type { Diagnostic } from "@averri/ir";
import { emit } from "../diagnostics.js";
import type { RuleContext } from "./context.js";
import { allContracts, misspelledRoot, offsetRange } from "./context.js";

export function ruleA3001(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const c of allContracts(ctx.state)) {
    const owner = ctx.state.factsById.get(c.owner);
    if (!owner || owner.site.construct !== "action" || owner.subjectEntity) continue;
    if (owner.props.has("subject")) continue; // subject present but not lowered: A1003/A1004 already reported
    const bad = c.sites.find((s) => !s.inElement && !(s.kind === "lhs" && misspelledRoot(s.raw)) && (s.ref.startsWith("self.") || s.ref.startsWith("old.")));
    if (!bad) continue;
    out.push(
      emit("A3001", {
        node: c.id,
        src: offsetRange(ctx.state, bad.file, bad.start, bad.end),
        title: `self/old reference without a subject: ${bad.ref}`,
        message: `${c.id} references ${bad.ref}${bad.kind === "lhs" && !bad.raw.includes(".") ? ` (the bare path "${bad.raw}" means self.${bad.raw})` : ""}, but ${owner.nodeId} declares no subject. Add subject: { entity, where } or reference input/result.`,
      }),
    );
  }
  return out;
}
