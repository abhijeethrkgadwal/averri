/**
 * Edge helpers (SPEC-IR §5): keys, provenance ranking, dedupe (higher provenance wins), add, and
 * queries by kind/endpoint, plus the per-node grouped view `inspect` renders. Pure; no IO.
 */

import { EDGE_KINDS, type Edge, type EdgeKind, type Graph, type NodeId, type Origin, type Provenance } from "./types.js";
import { compareIds } from "./ids.js";

const EDGE_KIND_INDEX: ReadonlyMap<string, number> = new Map(EDGE_KINDS.map((k, i) => [k, i]));

export function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === "string" && EDGE_KIND_INDEX.has(value);
}

/** Identity key of an edge: `(kind, from, to)`; rendered as `<kind>:<from>-><to>` (the diff `target` format). */
export function edgeKey(edge: Pick<Edge, "kind" | "from" | "to">): string {
  return `${edge.kind}:${edge.from}->${edge.to}`;
}

/** Inverse of {@link edgeKey}. Returns `null` when the string is not a well-formed key. */
export function parseEdgeKey(key: string): Pick<Edge, "kind" | "from" | "to"> | null {
  const colon = key.indexOf(":");
  if (colon <= 0) return null;
  const kind = key.slice(0, colon);
  if (!isEdgeKind(kind)) return null;
  const rest = key.slice(colon + 1);
  const arrow = rest.indexOf("->");
  if (arrow <= 0) return null;
  const from = rest.slice(0, arrow);
  const to = rest.slice(arrow + 2);
  if (from.length === 0 || to.length === 0) return null;
  return { kind, from: from as NodeId, to: to as NodeId };
}

/** `verified` > `declared` > `extracted`. */
export const ORIGIN_RANK: Readonly<Record<Origin, number>> = { extracted: 0, declared: 1, verified: 2 };

export function provenanceRank(p: Provenance | Origin): number {
  return ORIGIN_RANK[typeof p === "string" ? p : p.origin];
}

/** Negative when `a` is lower than `b`. */
export function compareProvenance(a: Provenance | Origin, b: Provenance | Origin): number {
  return provenanceRank(a) - provenanceRank(b);
}

/** The lower-ranked of two provenances (used when a derived fact is only as trustworthy as its weakest source). */
export function minProvenance(a: Provenance, b: Provenance): Provenance {
  return provenanceRank(a) <= provenanceRank(b) ? a : b;
}

/** Sort order for edges: `(kind, from, to)`, with provenance rank descending as a tiebreak for unmerged duplicates. */
export function compareEdges(a: Edge, b: Edge): number {
  const ka = EDGE_KIND_INDEX.get(a.kind) ?? -1;
  const kb = EDGE_KIND_INDEX.get(b.kind) ?? -1;
  if (ka !== kb) return compareIds(a.kind, b.kind);
  return compareIds(a.from, b.from) || compareIds(a.to, b.to) || provenanceRank(b.provenance) - provenanceRank(a.provenance);
}

/**
 * Deduplicate on `(kind, from, to)`, keeping the edge with the highest provenance. When provenances tie,
 * the first occurrence wins but its `attrs` are merged with later ones (later keys never overwrite).
 * Output order is the first-occurrence order of each key (call {@link sortEdges} for canonical order).
 */
export function dedupeEdges(edges: Iterable<Edge>): Edge[] {
  const byKey = new Map<string, Edge>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, edge);
      continue;
    }
    byKey.set(key, mergeEdge(existing, edge));
  }
  return [...byKey.values()];
}

function mergeEdge(existing: Edge, incoming: Edge): Edge {
  const higher = provenanceRank(incoming.provenance) > provenanceRank(existing.provenance) ? incoming : existing;
  const lower = higher === incoming ? existing : incoming;
  const attrs = { ...(lower.attrs ?? {}), ...(higher.attrs ?? {}) };
  const merged: Edge = { kind: higher.kind, from: higher.from, to: higher.to, provenance: higher.provenance };
  if (Object.keys(attrs).length > 0) merged.attrs = attrs;
  return merged;
}

/** Return a new array with `edge` added under the dedupe rule (the input array is not mutated). */
export function addEdge(edges: readonly Edge[], edge: Edge): Edge[] {
  const key = edgeKey(edge);
  const index = edges.findIndex((e) => edgeKey(e) === key);
  if (index < 0) return [...edges, edge];
  const out = edges.slice();
  out[index] = mergeEdge(edges[index]!, edge);
  return out;
}

/** Canonical edge order `(kind, from, to)`; returns a new array. */
export function sortEdges(edges: readonly Edge[]): Edge[] {
  return edges.slice().sort(compareEdges);
}

export function edgesOfKind(edges: readonly Edge[], kind: EdgeKind): Edge[] {
  return edges.filter((e) => e.kind === kind);
}

export function edgesFrom(edges: readonly Edge[], from: NodeId, kind?: EdgeKind): Edge[] {
  return edges.filter((e) => e.from === from && (kind === undefined || e.kind === kind));
}

export function edgesTo(edges: readonly Edge[], to: NodeId, kind?: EdgeKind): Edge[] {
  return edges.filter((e) => e.to === to && (kind === undefined || e.kind === kind));
}

/** Edges with `id` at either endpoint. */
export function edgesTouching(edges: readonly Edge[], id: NodeId, kind?: EdgeKind): Edge[] {
  return edges.filter((e) => (e.from === id || e.to === id) && (kind === undefined || e.kind === kind));
}

export function hasEdge(edges: readonly Edge[], kind: EdgeKind, from: NodeId, to: NodeId): boolean {
  return edges.some((e) => e.kind === kind && e.from === from && e.to === to);
}

/** Targets of outgoing edges of `kind` from `id`, sorted and unique. */
export function targetsOf(edges: readonly Edge[], from: NodeId, kind: EdgeKind): NodeId[] {
  return uniqueSorted(edgesFrom(edges, from, kind).map((e) => e.to));
}

/** Sources of incoming edges of `kind` to `id`, sorted and unique. */
export function sourcesOf(edges: readonly Edge[], to: NodeId, kind: EdgeKind): NodeId[] {
  return uniqueSorted(edgesTo(edges, to, kind).map((e) => e.from));
}

/**
 * Edges grouped by kind from one node's perspective regardless of direction (the `inspect` view).
 * Each entry lists the OTHER endpoint; `dependsOn` is excluded (use {@link dependentsOf} in depends.ts).
 */
export function groupEdgesByKind(edges: readonly Edge[], id: NodeId): Partial<Record<EdgeKind, NodeId[]>> {
  const out: Partial<Record<EdgeKind, NodeId[]>> = {};
  for (const e of edges) {
    if (e.kind === "dependsOn") continue;
    const other = e.from === id ? e.to : e.to === id ? e.from : null;
    if (other === null) continue;
    (out[e.kind] ??= []).push(other);
  }
  for (const k of Object.keys(out) as EdgeKind[]) out[k] = uniqueSorted(out[k]!);
  return out;
}

/** Edges whose endpoints are both present in `graph.nodes`; the rest are returned as `dangling`. */
export function partitionDanglingEdges(graph: Pick<Graph, "nodes" | "edges">): { valid: Edge[]; dangling: Edge[] } {
  const valid: Edge[] = [];
  const dangling: Edge[] = [];
  for (const e of graph.edges) (graph.nodes[e.from] && graph.nodes[e.to] ? valid : dangling).push(e);
  return { valid, dangling };
}

export function uniqueSorted<T extends string>(items: readonly T[]): T[] {
  return [...new Set(items)].sort(compareIds);
}
