/**
 * A3010 — Reference root looks misspelled: a bare lhs path whose first segment is within edit distance
 * 2 of a ref root and is not a field of the subject (`"reslt.email"`). Fix: patch to the closest root.
 */

import type { Diagnostic, Fix } from "@averri/ir";
import { emit, patchFix } from "../diagnostics.js";
import { allContracts, fieldOf, misspelledRoot, offsetRange, rootEntity, type RuleContext } from "./context.js";

export function ruleA3010(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const c of allContracts(state)) {
    const subject = rootEntity(state, c, "self");
    for (const s of c.sites) {
      if (s.kind !== "lhs" || s.inElement) continue;
      const root = misspelledRoot(s.raw, (name) => (subject ? fieldOf(state, subject, name) !== null : false));
      if (!root) continue;
      const first = s.raw.split(".")[0] as string;
      const fixed = `${root}${s.raw.slice(first.length)}`;
      const fixes: Fix[] = [];
      const text = state.text(s.file);
      if (text !== null) {
        const literal = text.slice(s.start, s.end);
        const quote = literal[0] as string;
        const fix = patchFix(`Use ${root}.*`, `"${first}" is within edit distance 2 of the root "${root}" and is not a field of the subject`, s.file, text, [
          { start: s.start, end: s.end, text: `${quote}${fixed}${quote}` },
        ]);
        if (fix) fixes.push(fix);
      }
      out.push(
        emit("A3010", {
          node: c.id,
          src: offsetRange(state, s.file, s.start, s.end),
          title: `Reference root looks misspelled: "${s.raw}" (did you mean ${root}?)`,
          message: `A bare path means self.<field>, so "${s.raw}" was read as self.${s.raw}.`,
          fixes,
        }),
      );
    }
  }
  return out;
}
