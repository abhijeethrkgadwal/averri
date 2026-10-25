/**
 * Graph canonicalisation (SPEC-IR §6): deterministic node/edge/diagnostic order, counts, and the
 * byte-stable serialisation written to `.averri/graph.json`. Pure; no IO.
 */

import { NODE_KINDS, type Diagnostic, type Graph, type Node, type NodeId, type NodeKind } from "./types.js";
import { canonicalJson } from "./ast.js";
import { compareIds, parseNodeId } from "./ids.js";
import { dedupeEdges, sortEdges } from "./edges.js";

/** Diagnostics are ordered by `id` (`D-0001` < `D-0002`), numerically when both parse. */
export function compareDiagnosticIds(a: string, b: string): number {
  const na = /^D-(\d+)$/.exec(a);
  const nb = /^D-(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]) || compareIds(a, b);
  return compareIds(a, b);
}

/** Node ids in canonical order (code-unit ascending). */
export function sortedNodeIds(nodes: Readonly<Record<string, Node>>): NodeId[] {
  return (Object.keys(nodes) as NodeId[]).sort(compareIds);
}

/** Nodes as a record with keys in canonical order (object key order is insertion order for non-integer keys). */
export function sortNodes(nodes: Readonly<Record<string, Node>>): Record<NodeId, Node> {
  const out: Record<string, Node> = {};
  for (const id of sortedNodeIds(nodes)) out[id] = nodes[id]!;
  return out as Record<NodeId, Node>;
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.slice().sort((a, b) => compareDiagnosticIds(a.id, b.id));
}

/**
 * Canonical form of a graph: node keys sorted, edges deduplicated (higher provenance wins) and sorted by
 * `(kind, from, to)`, diagnostics sorted by id. Node payloads are not reordered (their arrays are in
 * source order by spec). Returns a new object; the input is not mutated.
 */
export function sortGraph(graph: Graph): Graph {
  return {
    meta: graph.meta,
    nodes: sortNodes(graph.nodes),
    edges: sortEdges(dedupeEdges(graph.edges)),
    diagnostics: sortDiagnostics(graph.diagnostics),
  };
}

/** One integer per NodeKind, computed from `nodes` (every kind present, zero when absent). */
export function computeCounts(nodes: Readonly<Record<string, Node>>): Record<NodeKind, number> {
  const counts = Object.fromEntries(NODE_KINDS.map((k) => [k, 0])) as Record<NodeKind, number>;
  for (const node of Object.values(nodes)) counts[node.kind] += 1;
  return counts;
}

/** Sum of `counts` over every kind. */
export function sumCounts(counts: Readonly<Record<NodeKind, number>>): number {
  return NODE_KINDS.reduce((acc, k) => acc + (counts[k] ?? 0), 0);
}

/**
 * The deterministic `graph.json` text: {@link sortGraph} then {@link canonicalJson} with 2-space
 * indent and a trailing newline. Two builds of identical content differ only in `meta.builtAt`/`meta.root`.
 */
export function serializeGraph(graph: Graph): string {
  return `${canonicalJson(sortGraph(graph), 2)}\n`;
}

/**
 * Hash input for "same graph?" comparisons: the canonical JSON of the graph with the two
 * build-specific meta fields (`builtAt`, `root`) blanked.
 */
export function graphIdentityJson(graph: Graph): string {
  const sorted = sortGraph(graph);
  return canonicalJson({ ...sorted, meta: { ...sorted.meta, builtAt: "", root: "" } });
}

/** Nodes of one kind, in canonical id order. */
export function nodesOfKind<K extends NodeKind>(graph: Pick<Graph, "nodes">, kind: K): Array<Extract<Node, { kind: K }>> {
  const out: Array<Extract<Node, { kind: K }>> = [];
  for (const id of sortedNodeIds(graph.nodes)) {
    const n = graph.nodes[id]!;
    if (n.kind === kind) out.push(n as Extract<Node, { kind: K }>);
  }
  return out;
}

/** Kind of a node id without touching the graph; `null` when malformed. */
export function nodeKindOfId(id: string): NodeKind | null {
  return parseNodeId(id)?.kind ?? null;
}
