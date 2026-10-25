/**
 * Health counters (SPEC-IR §8) computed from a graph. Pure; no IO. The one counter that needs the
 * filesystem (`staleGeneratedTests`, which compares `sourceHash` with the `@generated` header on disk)
 * is supplied by the caller as a number or a predicate over generated Test nodes.
 */

import type { Graph, HealthCounters, TestNode } from "./types.js";
import { countBySeverity } from "./diagnostics.js";
import { edgesFrom } from "./edges.js";

export interface HealthOptions {
  /** `config.authMiddleware`: bare callee names that establish `actor` (`auth`, `requireUser`). Default `[]`. */
  authMiddleware?: readonly string[];
  /**
   * Generated tests whose file is missing or whose header hash differs. A number is used verbatim; a
   * predicate is evaluated per generated Test node. Default `0` (no filesystem knowledge).
   */
  staleGeneratedTests?: number | ((test: TestNode) => boolean);
  /** Confidence below which an extracted node counts as low-confidence. Default `0.9` (SPEC-IR §3). */
  confidenceThreshold?: number;
}

/** Bare callee name of a middleware identifier as written: `requireRole("admin")` -> `requireRole`, `auth` -> `auth`. */
export function middlewareCallee(identifier: string): string {
  const trimmed = identifier.trim();
  const paren = trimmed.indexOf("(");
  const head = paren >= 0 ? trimmed.slice(0, paren) : trimmed;
  const dot = head.lastIndexOf(".");
  return (dot >= 0 ? head.slice(dot + 1) : head).trim();
}

/** True when any middleware's callee is in `authMiddleware`. */
export function hasAuthMiddleware(middleware: readonly string[], authMiddleware: readonly string[]): boolean {
  if (authMiddleware.length === 0) return false;
  const set = new Set(authMiddleware);
  return middleware.some((m) => set.has(middlewareCallee(m)));
}

export function computeHealth(graph: Pick<Graph, "nodes" | "edges" | "diagnostics">, options: HealthOptions = {}): HealthCounters {
  const authMiddleware = options.authMiddleware ?? [];
  const threshold = options.confidenceThreshold ?? 0.9;
  const h: HealthCounters = {
    exposures: 0,
    exposuresWithoutPolicy: 0,
    exposuresUndeclared: 0,
    actionsDeclared: 0,
    actionsObserve: 0,
    queries: 0,
    contracts: 0,
    opaqueGuards: 0,
    handlerLines: 0,
    totalLines: 0,
    eventsWithoutConsumer: 0,
    staleGeneratedTests: 0,
    lowConfidenceNodes: 0,
    errors: 0,
    warnings: 0,
  };
  const stalePredicate = typeof options.staleGeneratedTests === "function" ? options.staleGeneratedTests : null;
  for (const node of Object.values(graph.nodes)) {
    if (node.provenance.origin === "extracted" && node.provenance.confidence < threshold) h.lowConfidenceNodes += 1;
    switch (node.kind) {
      case "Exposure":
        h.exposures += 1;
        if (node.boundTo === null) {
          h.exposuresUndeclared += 1;
          if (!node.public && !hasAuthMiddleware(node.middleware, authMiddleware)) h.exposuresWithoutPolicy += 1;
        }
        break;
      case "Action":
        if (node.mode === "declared") h.actionsDeclared += 1;
        else h.actionsObserve += 1;
        h.handlerLines += node.ratios.handlerLines;
        break;
      case "Query":
        h.queries += 1;
        h.handlerLines += node.ratios.handlerLines;
        break;
      case "Contract":
        h.contracts += 1;
        if (node.tier === "guard") h.opaqueGuards += 1;
        break;
      case "Module":
        if (node.role !== "test") h.totalLines += node.lines;
        break;
      case "Event":
        if (!node.external && edgesFrom(graph.edges, node.id, "consumedBy").length === 0) h.eventsWithoutConsumer += 1;
        break;
      case "Test":
        if (node.generated && stalePredicate && stalePredicate(node)) h.staleGeneratedTests += 1;
        break;
      default:
        break;
    }
  }
  if (typeof options.staleGeneratedTests === "number") h.staleGeneratedTests = options.staleGeneratedTests;
  const bySeverity = countBySeverity(graph.diagnostics);
  h.errors = bySeverity.error;
  h.warnings = bySeverity.warning;
  return h;
}

/** Ratios `overview` renders next to the counters; `null` when the denominator is 0. */
export function healthRatios(h: HealthCounters): { opaqueGuardRatio: number | null; handlerLineRatio: number | null } {
  return {
    opaqueGuardRatio: h.contracts === 0 ? null : h.opaqueGuards / h.contracts,
    handlerLineRatio: h.totalLines === 0 ? null : h.handlerLines / h.totalLines,
  };
}
