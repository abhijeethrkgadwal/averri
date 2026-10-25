/**
 * A2103 — Exposed route has no policy (D-7).
 * - warning: an Exposure with `boundTo: null`, `public: false` and no middleware whose callee is in
 *   `config.authMiddleware`;
 * - error: a bound declaration with neither `policy` nor `public` (only reachable when tsc is skipped).
 * Fix (error case only): when >= 2 sibling declarations in the same module share one policy, patch
 * `policy: <Sibling>`. There is NO `public: true` fallback fix.
 */

import type { ActionNode, Diagnostic, ExposureNode, Fix, NodeId, PolicyId, QueryNode } from "@averri/ir";
import { middlewareMatches } from "@averri/extract";
import { emit, patchFix } from "../diagnostics.js";
import { unwrapExpr } from "../lower/literal.js";
import type { DeclFacts } from "../model.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

export function ruleA2103(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  const auth = state.config.authMiddleware;
  const policies = [...state.nodes.values()].filter((n) => n.kind === "Policy").map((n) => n.id).sort(compareStrings) as NodeId[];
  for (const n of [...state.nodes.values()].sort((a, b) => compareStrings(a.id, b.id))) {
    if (n.kind !== "Exposure") continue;
    const x = n as ExposureNode;
    if (x.boundTo !== null || x.public) continue;
    if (x.middleware.some((m) => middlewareMatches(m, auth))) continue;
    out.push(
      emit("A2103", {
        severity: "warning",
        node: x.id,
        src: x.src,
        title: `Exposed route has no policy: ${x.method} ${x.path}`,
        message: `No declaration binds this route and none of its middleware (${x.middleware.length ? x.middleware.map((m) => m.slice(0, 30)).join(", ") : "none"}) is in config.authMiddleware. Declare it with a policy, or with public: true as the explicit opt-out.`,
        related: policies.slice(0, 5),
      }),
    );
  }
  for (const f of state.facts) {
    const n = state.nodes.get(f.nodeId);
    if (!n || (n.kind !== "Action" && n.kind !== "Query")) continue;
    const d = n as ActionNode | QueryNode;
    if (d.policy || d.public) continue;
    if (!d.route?.exposure) continue;
    const fixes: Fix[] = [];
    const sibling = siblingPolicy(ctx, f);
    if (sibling) {
      const fix = policyFix(ctx, f, sibling.text, sibling.count, sibling.policy);
      if (fix) fixes.push(fix);
    }
    out.push(
      emit("A2103", {
        severity: "error",
        node: d.id,
        src: d.src,
        title: `Exposed route has no policy: ${d.name}`,
        message: "The declaration has neither policy nor public: true. public: true is the explicit opt-out; it is never proposed automatically.",
        cause: [{ node: d.id, why: `bound to ${d.route.exposure} without policy or public` }],
        related: (sibling ? [sibling.policy, ...policies.filter((p) => p !== sibling.policy)] : policies).slice(0, 5),
        fixes,
      }),
    );
  }
  return out;
}

/** The policy shared by >= 2 sibling declarations in the same module, with the expression text they use. */
function siblingPolicy(ctx: RuleContext, f: DeclFacts): { policy: PolicyId; text: string; count: number } | null {
  const counts = new Map<PolicyId, { text: string; count: number }>();
  for (const g of ctx.state.facts) {
    if (g === f || g.site.file !== f.site.file) continue;
    const n = ctx.state.nodes.get(g.nodeId);
    if (!n || (n.kind !== "Action" && n.kind !== "Query")) continue;
    const pol = (n as ActionNode | QueryNode).policy;
    const prop = g.props.get("policy");
    if (!pol || !prop) continue;
    const c = counts.get(pol) ?? { text: unwrapExpr(prop.value).getText(), count: 0 };
    c.count++;
    counts.set(pol, c);
  }
  const shared = [...counts.entries()].filter(([, v]) => v.count >= 2);
  if (shared.length !== 1) return null;
  const [policy, v] = shared[0] as [PolicyId, { text: string; count: number }];
  return { policy, text: v.text, count: v.count };
}

function policyFix(ctx: RuleContext, f: DeclFacts, text: string, count: number, policy: PolicyId): Fix | null {
  const opts = f.site.options;
  const src = ctx.state.text(f.site.file);
  if (!opts || src === null) return null;
  // Insert after `output`, else `input`, else `route`, else as the first property (canonical slot).
  const anchorKey = ["output", "input", "route", "intent"].find((k) => f.props.has(k));
  const anchor = anchorKey ? f.props.get(anchorKey)?.prop : undefined;
  let insertAt: number;
  let indent: string;
  if (anchor) {
    insertAt = anchor.getEnd();
    const after = src.slice(insertAt);
    const comma = /^\s*,/.exec(after);
    if (comma) insertAt += comma[0].length;
    const lineStart = src.lastIndexOf("\n", anchor.getStart()) + 1;
    indent = src.slice(lineStart, anchor.getStart());
    if (!/^\s*$/.test(indent)) indent = "  ";
  } else {
    insertAt = opts.getStart() + 1;
    indent = "  ";
  }
  const textToInsert = anchor ? (src.slice(anchor.getEnd(), insertAt).includes(",") ? `\n${indent}policy: ${text},` : `,\n${indent}policy: ${text}`) : `\n${indent}policy: ${text},`;
  return patchFix(`Use ${policy.slice("Policy:".length)} like its siblings`, `used by ${count} sibling declarations in ${f.site.file}`, f.site.file, src, [
    { start: insertAt, end: insertAt, text: textToInsert },
  ]);
}
