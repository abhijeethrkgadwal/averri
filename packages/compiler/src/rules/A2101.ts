/**
 * A2101 — Declared route has no matching exposure. Deterministic fix: when the declaration's
 * `handler`/`run` symbol, or a `toHono(<Decl>)`/`toExpress(<Decl>)` call, is the handler of exactly one
 * Exposure, patch `route` to that Exposure's method + path.
 */

import { Node } from "ts-morph";
import type { ActionNode, Diagnostic, ExposureNode, Fix, NodeId, QueryNode } from "@averri/ir";
import { normalizeRoutePath } from "@averri/extract";
import { emit, patchFix } from "../diagnostics.js";
import { siteOf } from "../lower/declarations.js";
import { unwrapExpr } from "../lower/literal.js";
import type { DeclFacts } from "../model.js";
import type { TextEdit } from "../patch.js";
import type { BuildState } from "../state.js";
import { compareStrings, editDistance, rangeOf } from "../util.js";
import { registrationCall } from "../verify/index.js";
import type { RuleContext } from "./context.js";

function exposures(state: BuildState): ExposureNode[] {
  return [...state.nodes.values()].filter((n): n is ExposureNode => n.kind === "Exposure").sort((a, b) => compareStrings(a.id, b.id));
}

/** Exposures whose handler is this declaration: same handler symbol, or a toHono/toExpress(<Decl>) argument. */
export function exposuresHandledBy(state: BuildState, f: DeclFacts, node: ActionNode | QueryNode): ExposureNode[] {
  const out: ExposureNode[] = [];
  for (const x of exposures(state)) {
    if (node.handler && node.mode === "observe" && x.handler && x.handler.symbol !== "(anonymous)" && x.handler.file === node.handler.file && x.handler.symbol === node.handler.symbol) {
      out.push(x);
      continue;
    }
    const call = registrationCall(state, x);
    if (!call || !Node.isCallExpression(call)) continue;
    let hit = false;
    for (const arg of call.getArguments()) {
      const checkCall = (c: Node): void => {
        if (hit || !Node.isCallExpression(c)) return;
        const callee = unwrapExpr(c.getExpression());
        const name = Node.isIdentifier(callee) ? callee.getText() : Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
        if (name !== "toHono" && name !== "toExpress") return;
        const first = c.getArguments()[0];
        if (!first) return;
        const s = siteOf(state, first);
        if (s && s.nodeId === f.nodeId) hit = true;
      };
      const u = unwrapExpr(arg);
      checkCall(u);
      if (!hit) u.forEachDescendant((d) => checkCall(d));
      if (hit) break;
    }
    if (hit) out.push(x);
  }
  return out;
}

function routeFix(state: BuildState, f: DeclFacts, target: ExposureNode, reason: string): Fix | null {
  const prop = f.props.get("route");
  if (!prop) return null;
  const obj = unwrapExpr(prop.value);
  if (!Node.isObjectLiteralExpression(obj)) return null;
  const text = state.text(f.site.file);
  if (text === null) return null;
  const edits: TextEdit[] = [];
  for (const key of ["method", "path"] as const) {
    const p = obj.getProperty(key);
    if (!p || !Node.isPropertyAssignment(p)) return null;
    const init = p.getInitializer();
    if (!init || !(Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) return null;
    const want = key === "method" ? target.method : target.path;
    if (init.getLiteralText() === want) continue;
    const quote = init.getText()[0] as string;
    edits.push({ start: init.getStart(), end: init.getEnd(), text: `${quote}${want}${quote}` });
  }
  if (edits.length === 0) return null;
  return patchFix("Use the registered path", reason, f.site.file, text, edits);
}

export function ruleA2101(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const f of state.facts) {
    const n = state.nodes.get(f.nodeId);
    if (!n || (n.kind !== "Action" && n.kind !== "Query")) continue;
    const node = n as ActionNode | QueryNode;
    if (!node.route || node.route.verified) continue;
    const handled = exposuresHandledBy(state, f, node);
    const fixes: Fix[] = [];
    let related: NodeId[];
    const routeProp = f.props.get("route");
    const src = routeProp ? rangeOf(f.site.file, routeProp.prop) : node.src;
    const cause = [{ node: node.id, why: `declares route ${node.route.method} ${node.route.path}` }];
    if (handled.length === 1) {
      const x = handled[0] as ExposureNode;
      const handlerText = x.handler ? (x.handler.symbol === "(anonymous)" ? "an inline handler" : `handler ${x.handler.symbol}`) : "its handler";
      cause.push({ node: x.id, why: `registers ${x.method} ${x.path} with ${handlerText}` });
      const fix = routeFix(state, f, x, `${node.handler?.symbol && node.mode === "observe" ? node.handler.symbol : `toHono/toExpress(${f.site.constName ?? node.name})`} is the handler of exactly one exposure`);
      if (fix) fixes.push(fix);
      related = [x.id];
    } else {
      const declared = normalizeRoutePath(node.route.path);
      related = exposures(state)
        .filter((x) => x.method === node.route?.method)
        .map((x) => ({ id: x.id, d: editDistance(declared, normalizeRoutePath(x.path)) }))
        .sort((a, b) => a.d - b.d || compareStrings(a.id, b.id))
        .slice(0, 5)
        .map((x) => x.id);
      const best = related[0] ? (state.nodes.get(related[0]) as ExposureNode) : null;
      if (best) cause.push({ node: best.id, why: `closest registration: ${best.method} ${best.path}` });
    }
    out.push(
      emit("A2101", {
        node: node.id,
        src,
        title: `Declared route has no matching exposure: ${node.route.method} ${node.route.path}`,
        message:
          handled.length > 1
            ? `${handled.length} exposures use this declaration as handler; no unique fix.`
            : handled.length === 0
              ? "No Hono/Express registration has this method and normalised path (param names must match)."
              : undefined,
        cause,
        related,
        fixes,
      }),
    );
  }
  return out;
}
