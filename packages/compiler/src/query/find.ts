/**
 * `find` (SPEC-MCP §6.2): lexical/structural match over graph nodes, <= 800 tokens. Match classes:
 * exact id → prefix of qualifier → case-insensitive substring over name/summary/intent/route path →
 * token overlap; then kind priority. Under budget, hits are dropped from the end (into `more`), then
 * summary strings.
 */

import type { ActionNode, ExposureNode, Graph, Node, NodeId, NodeKind, Origin } from "@averri/ir";
import { verifyNote } from "../impact.js";
import { compareStrings } from "../util.js";
import { BUDGETS, capMore, responseTokens, type Bounded } from "./budget.js";

export const KIND_PRIORITY: readonly NodeKind[] = ["Action", "Query", "Exposure", "Entity", "Policy", "Event", "Workflow", "Integration", "Contract", "Test", "Field", "Module"];

export interface FindInput {
  query: string;
  kind?: NodeKind;
  limit?: number;
}

export interface FindHit {
  id: NodeId;
  kind: NodeKind;
  path: `${string}:${number}` | null;
  origin: Origin;
  summary?: string;
  verify?: string;
}

function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function routePath(n: Node): string {
  if (n.kind === "Exposure") return `${(n as ExposureNode).method} ${(n as ExposureNode).path}`;
  if ((n.kind === "Action" || n.kind === "Query") && (n as ActionNode).route) return `${(n as ActionNode).route?.method} ${(n as ActionNode).route?.path}`;
  return "";
}

/** Match class (0 best) and a secondary score, or null when the node does not match. */
export function matchClass(n: Node, query: string): [number, number] | null {
  const q = query.trim();
  const ql = q.toLowerCase();
  const qualifier = n.id.slice(n.id.indexOf(":") + 1);
  if (n.id === q || qualifier === q) return [0, 0];
  if (qualifier.toLowerCase().startsWith(ql) || n.id.toLowerCase().startsWith(ql)) return [1, qualifier.length];
  const hay = [n.name, n.summary, n.intent ?? "", routePath(n)].join("\n").toLowerCase();
  if (hay.includes(ql) || qualifier.toLowerCase().includes(ql)) return [2, 0];
  const qt = tokens(q);
  if (qt.length === 0) return null;
  const ht = new Set(tokens(`${qualifier} ${hay}`));
  const overlap = qt.filter((t) => ht.has(t)).length;
  return overlap > 0 ? [3, -overlap] : null;
}

export function find(graph: Graph, input: FindInput): Bounded<{ hits: FindHit[] }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 30);
  const scored: Array<{ n: Node; c: [number, number] }> = [];
  for (const n of Object.values(graph.nodes)) {
    if (input.kind && n.kind !== input.kind) continue;
    const c = matchClass(n, input.query);
    if (c) scored.push({ n, c });
  }
  scored.sort(
    (a, b) =>
      a.c[0] - b.c[0] ||
      a.c[1] - b.c[1] ||
      KIND_PRIORITY.indexOf(a.n.kind) - KIND_PRIORITY.indexOf(b.n.kind) ||
      compareStrings(a.n.id, b.n.id),
  );
  const all: FindHit[] = scored.map(({ n }) => {
    const hit: FindHit = {
      id: n.id,
      kind: n.kind,
      path: n.src ? (`${n.src.file}:${n.src.range[0][0]}` as const) : null,
      origin: n.provenance.origin,
      summary: n.summary,
    };
    const v = verifyNote(n);
    if (v) hit.verify = v;
    return hit;
  });
  const hits = all.slice(0, limit);
  const more: string[] = [];
  let truncated = false;
  const data = { hits };
  const minKeep = Math.min(5, hits.length);
  // The budget covers the envelope and `more` too (D-41d): measure what is returned.
  while (responseTokens(data, more) > BUDGETS.find && hits.length > minKeep) {
    more.unshift((hits.pop() as FindHit).id);
    truncated = true;
  }
  for (let i = hits.length - 1; i >= 0 && responseTokens(data, more) > BUDGETS.find; i--) {
    delete (hits[i] as FindHit).summary;
    truncated = true;
  }
  return more.length ? { data, truncated, more: capMore(more) } : { data, truncated };
}
