/**
 * A4001 — Emitted event is not declared: `emit(X, …)` in `run` where X is not an Event node
 * (`e.emitted(X)` with an unresolved X is reported while lowering). Fix: add
 * `export const X = event("X", { payload: { … } })` with payload keys taken from the emit call's object
 * literal (types from TS), importing `event` from `@averri/core` when needed.
 */

import { Node, type SourceFile } from "ts-morph";
import type { Diagnostic, Fix } from "@averri/ir";
import { emit, patchFix } from "../diagnostics.js";
import { CORE_MODULE, coreBindings } from "../lower/core-imports.js";
import type { TextEdit } from "../patch.js";
import { rangeOf } from "../util.js";
import type { UnknownEmit } from "../verify/effect-scan.js";
import type { RuleContext } from "./context.js";

const PASCAL_RE = /^[A-Z][A-Za-z0-9_]*$/;

export function ruleA4001(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const [id, scan] of [...ctx.verify.scans.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const seen = new Set<string>();
    for (const u of scan.unknownEmits) {
      if (seen.has(u.name)) continue;
      seen.add(u.name);
      const file = state.rel(u.call.getSourceFile());
      const fix = eventFix(ctx, u);
      out.push(
        emit("A4001", {
          node: id,
          src: rangeOf(file, u.call),
          title: `Emitted event is not declared: ${u.name}`,
          message: `emit(${u.name}, …) in ${id} does not reference an event() declaration.`,
          fixes: fix ? [fix] : [],
        }),
      );
    }
  }
  return out;
}

function eventFix(ctx: RuleContext, u: UnknownEmit): Fix | null {
  if (!PASCAL_RE.test(u.name)) return null;
  const sf = u.call.getSourceFile();
  const file = ctx.state.rel(sf);
  const text = ctx.state.text(file);
  if (text === null) return null;
  const edits: TextEdit[] = [];
  const b = coreBindings(sf);
  let eventName = [...b.constructs.entries()].find(([, c]) => c === "event")?.[0] ?? null;
  if (!eventName) {
    eventName = "event";
    const imp = sf.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === CORE_MODULE && !d.isTypeOnly() && d.getNamedImports().length > 0);
    if (imp) {
      const last = imp.getNamedImports()[imp.getNamedImports().length - 1] as Node;
      edits.push({ start: last.getEnd(), end: last.getEnd(), text: ", event" });
    } else {
      edits.push({ start: 0, end: 0, text: `import { event } from "${CORE_MODULE}";\n` });
    }
  }
  const payload = u.payload.map((p) => `${JSON.stringify(p.key).replace(/^"([A-Za-z_$][\w$]*)"$/, "$1")}: "${p.type}"`).join(", ");
  const decl = `export const ${u.name} = ${eventName}("${u.name}", { payload: { ${payload} } });\n\n`;
  const stmt = topLevelStatement(sf, u.call);
  if (!stmt) return null;
  const at = stmt.getStart(true);
  if (edits.length > 0 && edits[0]?.start === 0 && at === 0) edits[0].text += "\n";
  edits.push({ start: at, end: at, text: decl });
  return patchFix(`Declare event ${u.name}`, `emit(${u.name}, …) passes ${u.payload.length} payload key(s): ${u.payload.map((p) => p.key).join(", ") || "none"}`, file, text, edits);
}

function topLevelStatement(sf: SourceFile, node: Node): Node | null {
  let cur: Node | undefined = node;
  while (cur && cur.getParent() !== sf) cur = cur.getParent();
  return cur ?? null;
}
