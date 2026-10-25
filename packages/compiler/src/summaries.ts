/**
 * Derived one-line summaries (`NodeBase.summary`, <= 200 chars, used by `find`) for declared nodes.
 * Extracted nodes keep the extractor's summary.
 */

import { renderExpr, type ActionNode, type ContractNode, type Edge, type EventNode, type IntegrationNode, type Node, type PolicyNode, type QueryNode, type WorkflowNode } from "@averri/ir";
import { plural, summaryText } from "./util.js";

function q(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

export function summarize(nodes: Map<string, Node>, edges: readonly Edge[]): void {
  const from = new Map<string, Edge[]>();
  const to = new Map<string, Edge[]>();
  for (const e of edges) {
    from.set(e.from, [...(from.get(e.from) ?? []), e]);
    to.set(e.to, [...(to.get(e.to) ?? []), e]);
  }
  const targets = (id: string, kind: Edge["kind"]): string[] => Array.from(new Set((from.get(id) ?? []).filter((e) => e.kind === kind).map((e) => q(e.to)))).sort();
  const sources = (id: string, kind: Edge["kind"]): string[] => Array.from(new Set((to.get(id) ?? []).filter((e) => e.kind === kind).map((e) => q(e.from)))).sort();
  for (const n of nodes.values()) {
    if (n.provenance.origin === "extracted") continue;
    switch (n.kind) {
      case "Action": {
        const a = n as ActionNode;
        const parts: string[] = [];
        parts.push(a.route ? `${a.route.method} ${a.route.path}` : "internal");
        if (a.mode === "observe") parts.push("observe");
        parts.push(a.policy ? `policy ${q(a.policy)}` : a.public ? "public" : "no policy");
        parts.push(`${plural(a.ratios.totalContracts, "contract")}${a.ratios.opaqueGuards ? ` (${a.ratios.opaqueGuards} opaque)` : ""}`);
        const writes = targets(a.id, "writes");
        if (writes.length) parts.push(`writes ${writes.join(", ")}`);
        const emits = targets(a.id, "emits");
        if (emits.length) parts.push(`emits ${emits.join(", ")}`);
        a.summary = summaryText(parts.join(" · "));
        break;
      }
      case "Query": {
        const x = n as QueryNode;
        const parts = [x.route ? `${x.route.method} ${x.route.path}` : "internal", x.policy ? `policy ${q(x.policy)}` : x.public ? "public" : "no policy"];
        if (x.reads.length) parts.push(`reads ${x.reads.map(q).join(", ")}`);
        x.summary = summaryText(parts.join(" · "));
        break;
      }
      case "Policy": {
        const p = n as PolicyNode;
        const allow = nodes.get(p.allow) as ContractNode | undefined;
        const rule = allow?.expr ? renderExpr(allow.expr) : "opaque guard";
        p.summary = summaryText(`${p.tier} policy · ${plural(p.appliesTo.filter((x) => !x.startsWith("Exposure:")).length, "declaration")} · allow ${rule}`);
        break;
      }
      case "Contract": {
        const c = n as ContractNode;
        c.summary = summaryText(`${c.phase} ${c.clause} of ${q(c.of)} · ${c.tier}${c.expr ? ` · ${renderExpr(c.expr)}` : " · opaque guard"}`);
        break;
      }
      case "Event": {
        const ev = n as EventNode;
        const consumers = targets(ev.id, "consumedBy");
        const emitters = sources(ev.id, "emits");
        const parts = [`payload ${Object.keys(ev.payload).join(", ") || "{}"}`];
        if (emitters.length) parts.push(`emitted by ${emitters.join(", ")}`);
        parts.push(consumers.length ? `consumed by ${consumers.join(", ")}` : ev.external ? "external" : "no consumer");
        ev.summary = summaryText(parts.join(" · "));
        break;
      }
      case "Workflow": {
        const w = n as WorkflowNode;
        w.summary = summaryText(`on ${q(w.on)} · ${w.engine}${w.steps.length ? ` · steps ${w.steps.join(", ")}` : ""}${w.retry ? ` · retry ${w.retry.attempts}` : ""}`);
        break;
      }
      case "Integration": {
        const i = n as IntegrationNode;
        const parts = [i.client ? `client ${i.client.symbol}` : "no client"];
        if (i.webhook) parts.push(`webhook ${i.webhook.verify} (${i.webhook.scheme})${i.webhook.rawBody ? " raw body" : ""}`);
        if (i.idempotency) parts.push("idempotent");
        if (i.nonTransactional) parts.push("non-transactional");
        i.summary = summaryText(parts.join(" · "));
        break;
      }
      case "Entity": {
        if (n.intent) n.summary = summaryText(`${n.summary.replace(/ · intent .*$/, "")} · intent ${n.intent}`);
        break;
      }
      default:
        break;
    }
  }
}
