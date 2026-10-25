/**
 * A3007 — Literal string on the right of a comparison looks like a reference (`e.eq("input.email",
 * "result.email")`). Fix: wrap it in `e.<root>("<rest>")`.
 */

import type { Diagnostic, Fix } from "@averri/ir";
import { emit, patchFix } from "../diagnostics.js";
import { coreBindings } from "../lower/core-imports.js";
import { allContracts, offsetRange, type RuleContext } from "./context.js";

export function ruleA3007(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const c of allContracts(state)) {
    for (const lit of c.rhsRefLiterals) {
      const dot = lit.value.indexOf(".");
      const root = lit.value.slice(0, dot);
      const rest = lit.value.slice(dot + 1);
      const sf = state.ctx.sourceFile(lit.file);
      const eName = sf ? ([...coreBindings(sf).e][0] ?? null) : null;
      const fixes: Fix[] = [];
      const text = state.text(lit.file);
      if (eName && text !== null) {
        const fix = patchFix(`Wrap in ${eName}.${root}()`, `the right-hand side is always a literal; "${lit.value}" names the ${root} root`, lit.file, text, [
          { start: lit.start, end: lit.end, text: `${eName}.${root}(${JSON.stringify(rest)})` },
        ]);
        if (fix) fixes.push(fix);
      }
      out.push(
        emit("A3007", {
          node: c.id,
          src: offsetRange(state, lit.file, lit.start, lit.end),
          title: `Literal on the right looks like a reference: "${lit.value}"`,
          message: `Strings on the right of a comparison are literals; use ${eName ?? "e"}.${root}("${rest}") to reference ${lit.value}.`,
          fixes,
        }),
      );
    }
  }
  return out;
}
