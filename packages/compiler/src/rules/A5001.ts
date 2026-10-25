/**
 * A5001 — Webhook route appears to parse the body before signature verification (D-17): with
 * `webhook.rawBody: true`, the Exposure's inline Hono chain / Express inline arguments contain a JSON
 * body parser (`c.req.json()`, `express.json()`, `bodyParser.json()`) before the code reading the
 * `verify` header. Inline forms only; path-level `use()` ordering is not inspected.
 */

import { Node } from "ts-morph";
import type { Diagnostic, ExposureNode, IntegrationNode } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { registrationCall } from "../verify/index.js";
import type { RuleContext } from "./context.js";

const PARSER_RE = /\b(?:c\.req\.json|express\.json|bodyParser\.json|req\.json|request\.json)\s*\(/;

export function ruleA5001(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  for (const n of state.nodes.values()) {
    if (n.kind !== "Integration") continue;
    const integ = n as IntegrationNode;
    if (!integ.webhook?.rawBody || !integ.webhook.exposure) continue;
    const x = state.nodes.get(integ.webhook.exposure) as ExposureNode | undefined;
    if (!x) continue;
    const call = registrationCall(state, x);
    if (!call || !Node.isCallExpression(call)) continue;
    const header = integ.webhook.verify.toLowerCase();
    // Concatenate the inline arguments after the path, in order.
    const args = call.getArguments().slice(1);
    const text = args.map((a) => a.getText()).join("\n");
    const parser = PARSER_RE.exec(text);
    const headerIdx = text.toLowerCase().search(new RegExp(`["'\`]${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`));
    if (!parser || (headerIdx >= 0 && parser.index > headerIdx)) continue;
    out.push(
      emit("A5001", {
        node: x.id,
        src: x.src,
        title: `Webhook route parses the body before verifying ${integ.webhook.verify}`,
        message: `${parser[0].replace(/\s*\($/, "()")} appears ${headerIdx >= 0 ? "before the code reading" : "while no inline code reads"} the ${integ.webhook.verify} header; signature checks need the raw body (rawBody: true). The generated pitfall.raw-body test is the real check.`,
        cause: [
          { node: x.id, why: `inline handler chain calls ${parser[0].replace(/\s*\($/, "()")}` },
          { node: integ.id, why: "declares webhook.rawBody: true" },
        ],
        related: [integ.id],
      }),
    );
  }
  return out;
}
