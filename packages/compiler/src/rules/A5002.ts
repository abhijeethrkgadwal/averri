/**
 * A5002 — Webhook or payment handler has no idempotency: an Exposure bound to a webhook integration or
 * whose path matches `/webhooks?/`, with no `idempotency` fact (on the integration or the bound
 * declaration) and no detected dedupe-table access (a read/write of an entity named like
 * `WebhookEvent`, `ProcessedEvent`, `IdempotencyKey`, `Dedupe*`).
 */

import type { ActionNode, Diagnostic, ExposureNode, IntegrationNode, NodeId } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { compareStrings } from "../util.js";
import type { RuleContext } from "./context.js";

const DEDUPE_ENTITY_RE = /webhook|idempot|dedup|processed/i;
const WEBHOOK_PATH_RE = /\/webhooks?(\/|$)/;

export function ruleA5002(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const state = ctx.state;
  const byExposure = new Map<NodeId, IntegrationNode>();
  for (const n of state.nodes.values()) {
    if (n.kind === "Integration" && (n as IntegrationNode).webhook?.exposure) byExposure.set((n as IntegrationNode).webhook?.exposure as NodeId, n as IntegrationNode);
  }
  for (const n of [...state.nodes.values()].sort((a, b) => compareStrings(a.id, b.id))) {
    if (n.kind !== "Exposure") continue;
    const x = n as ExposureNode;
    const integ = byExposure.get(x.id);
    if (!integ && !WEBHOOK_PATH_RE.test(x.path)) continue;
    if (integ?.idempotency) continue;
    const bound = x.boundTo ? state.nodes.get(x.boundTo) : undefined;
    if (bound?.kind === "Action" && (bound as ActionNode).idempotency) continue;
    if (bound) {
      const touched = state.edges.filter((e) => e.from === bound.id && (e.kind === "writes" || e.kind === "reads")).map((e) => e.to);
      if (touched.some((t) => DEDUPE_ENTITY_RE.test(t))) continue;
    }
    out.push(
      emit("A5002", {
        node: x.id,
        src: x.src,
        title: `Webhook handler has no idempotency: ${x.method} ${x.path}`,
        message: `Providers redeliver webhooks; declare idempotency: { key, ttlSeconds } on the ${integ ? `integration ${integ.name}` : "bound declaration"} to get the duplicate-delivery test, or dedupe on a processed-events table.`,
        related: [...(integ ? [integ.id] : []), ...(bound ? [bound.id] : [])],
      }),
    );
  }
  return out;
}
