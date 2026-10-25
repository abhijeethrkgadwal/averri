/**
 * `dependsOn` closure (SPEC-IR §5, D-10): the directed propagation table applied transitively for at
 * most 2 steps, with `attrs.via` listing the intermediate node. `X -dependsOn-> Y` means "X is affected
 * when Y changes". Computed by the compiler's impact pass; never authored. Pure; no IO.
 *
 * Provenance of a computed edge is the lowest-ranked provenance among the facts it was derived from
 * (the underlying edge, or the Contract node whose refs name a Field); a two-step edge takes the lower
 * of its two steps.
 */

import type { ContractNode, Edge, EntityId, FieldId, Graph, Node, NodeId, Provenance } from "./types.js";
import { collectDbPredicates, collectRefs, refRoot, refSegments } from "./ast.js";
import { compareEdges, minProvenance, uniqueSorted } from "./edges.js";
import { fieldId, parseFieldId } from "./ids.js";
import { sortedNodeIds } from "./graph.js";

/** A direct dependency with the fact it rests on. */
interface Direct {
  from: NodeId;
  to: NodeId;
  provenance: Provenance;
}

/**
 * Compute every `dependsOn` edge for the graph from its non-`dependsOn` edges and node payloads.
 * Existing `dependsOn` edges in the input are ignored. Output is deduplicated and in canonical order.
 */
export function computeDependsOn(graph: Pick<Graph, "nodes" | "edges">): Edge[] {
  const direct = directDependencies(graph);
  const byTarget = new Map<NodeId, Direct[]>();
  const keyed = new Map<string, Direct>();
  for (const d of direct) {
    if (d.from === d.to) continue;
    const key = `${d.from}->${d.to}`;
    const existing = keyed.get(key);
    if (!existing) {
      keyed.set(key, d);
      (byTarget.get(d.to) ?? byTarget.set(d.to, []).get(d.to)!).push(d);
    } else if (rank(d.provenance) > rank(existing.provenance)) {
      existing.provenance = d.provenance;
    }
  }
  const out = new Map<string, Edge>();
  for (const d of keyed.values()) out.set(`${d.from}->${d.to}`, { kind: "dependsOn", from: d.from, to: d.to, provenance: d.provenance });
  // Second step: W dependsOn X and X dependsOn Y => W dependsOn Y via X.
  for (const step1 of keyed.values()) {
    const x = step1.from;
    const y = step1.to;
    for (const step2 of byTarget.get(x) ?? []) {
      const w = step2.from;
      if (w === y) continue;
      const key = `${w}->${y}`;
      if (keyed.has(key)) continue;
      const provenance = minProvenance(step1.provenance, step2.provenance);
      const existing = out.get(key);
      if (!existing) {
        out.set(key, { kind: "dependsOn", from: w, to: y, provenance, attrs: { via: [x] } });
      } else {
        const via = uniqueSorted([...((existing.attrs?.via as string[] | undefined) ?? []), x]);
        existing.attrs = { ...existing.attrs, via };
        if (rank(provenance) > rank(existing.provenance)) existing.provenance = provenance;
      }
    }
  }
  return [...out.values()].sort(compareEdges);
}

function rank(p: Provenance): number {
  return p.origin === "verified" ? 2 : p.origin === "declared" ? 1 : 0;
}

/** Nodes affected when `id` changes: sources of incoming `dependsOn` edges, sorted. */
export function dependentsOf(graph: Pick<Graph, "edges">, id: NodeId): NodeId[] {
  return uniqueSorted(graph.edges.filter((e) => e.kind === "dependsOn" && e.to === id).map((e) => e.from));
}

/** Nodes whose change affects `id`: targets of outgoing `dependsOn` edges, sorted. */
export function dependenciesOf(graph: Pick<Graph, "edges">, id: NodeId): NodeId[] {
  return uniqueSorted(graph.edges.filter((e) => e.kind === "dependsOn" && e.from === id).map((e) => e.to));
}

/**
 * Impact of a set of changed nodes: every dependent with the edge path (`why`: `[changed, ...via]`).
 * Sorted by affected id; `why` is the shortest path when several exist.
 */
export function affectedBy(graph: Pick<Graph, "edges">, changed: readonly NodeId[]): Array<{ id: NodeId; why: NodeId[] }> {
  const changedSet = new Set(changed);
  const best = new Map<NodeId, NodeId[]>();
  for (const e of graph.edges) {
    if (e.kind !== "dependsOn" || !changedSet.has(e.to) || changedSet.has(e.from)) continue;
    const via = (e.attrs?.via as string[] | undefined) ?? [];
    const why = [e.to, ...(via as NodeId[])];
    const existing = best.get(e.from);
    if (!existing || why.length < existing.length || (why.length === existing.length && why.join() < existing.join())) best.set(e.from, why);
  }
  return [...best.entries()].map(([id, why]) => ({ id, why })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- propagation table ------------------------------------------------------------

function directDependencies(graph: Pick<Graph, "nodes" | "edges">): Direct[] {
  const out: Direct[] = [];
  const nodes = graph.nodes;
  const edges = graph.edges.filter((e) => e.kind !== "dependsOn");
  const push = (from: NodeId, to: NodeId, provenance: Provenance): void => {
    if (nodes[from] && nodes[to]) out.push({ from, to, provenance });
  };

  for (const e of edges) {
    const fromNode = nodes[e.from];
    const toNode = nodes[e.to];
    if (!fromNode || !toNode) continue;
    switch (e.kind) {
      // Entity changes: nodes reading/writing/returning it.
      case "reads":
      case "writes":
      case "returns":
        if (toNode.kind === "Entity") push(e.from, e.to, e.provenance);
        break;
      // Entity changes: its persistedBy Module.
      case "persistedBy":
        if (fromNode.kind === "Entity") push(e.to, e.from, e.provenance);
        break;
      // Policy changes: everything it authorizes.
      case "authorizes":
        if (fromNode.kind === "Policy") push(e.to, e.from, e.provenance);
        break;
      // Contract changes: its owner.
      case "constrains":
        if (fromNode.kind === "Contract") push(e.to, e.from, e.provenance);
        break;
      // Event changes: emitters and consumers.
      case "emits":
        if (toNode.kind === "Event") push(e.from, e.to, e.provenance);
        break;
      case "consumedBy":
        if (fromNode.kind === "Event") push(e.to, e.from, e.provenance);
        break;
      // Module (declaration/handler/route) changes: what it contains and who validates/implements through it.
      case "contains":
        if (fromNode.kind === "Module" && isCodeModule(fromNode)) push(e.to, e.from, e.provenance);
        break;
      case "validatesWith":
      case "implementedBy":
        if (toNode.kind === "Module" && isCodeModule(toNode) && (fromNode.kind === "Action" || fromNode.kind === "Query")) {
          push(e.from, e.to, e.provenance);
        }
        break;
      // Exposure changes: the declaration it exposes. Action/Query changes: Exposures serving them.
      case "exposes":
        if (fromNode.kind === "Exposure") {
          push(e.to, e.from, e.provenance);
          push(e.from, e.to, e.provenance);
        }
        break;
      // Action/Query/Workflow/Integration/Contract changes: their Tests.
      case "verifiedBy":
        if (toNode.kind === "Test") {
          if (
            fromNode.kind === "Action" ||
            fromNode.kind === "Query" ||
            fromNode.kind === "Workflow" ||
            fromNode.kind === "Integration" ||
            fromNode.kind === "Contract"
          ) {
            push(e.to, e.from, e.provenance);
          }
        }
        break;
      default:
        break;
    }
  }

  // Contract changes: Tests covering the Contract's owner.
  const verifiedByOwner = new Map<NodeId, Edge[]>();
  for (const e of edges) {
    if (e.kind === "verifiedBy" && nodes[e.to]?.kind === "Test") (verifiedByOwner.get(e.from) ?? verifiedByOwner.set(e.from, []).get(e.from)!).push(e);
  }
  for (const id of sortedNodeIds(nodes)) {
    const node = nodes[id]!;
    if (node.kind !== "Contract") continue;
    for (const e of verifiedByOwner.get(node.of) ?? []) push(e.to, node.id, e.provenance);
    // Field changes: Contracts whose refs/where name the Field.
    for (const field of fieldsNamedByContract(graph, node)) push(node.id, field, node.provenance);
  }
  return out;
}

function isCodeModule(node: Node): boolean {
  return node.kind === "Module" && (node.role === "declaration" || node.role === "handler" || node.role === "route");
}

/** Resolve the Field ids a Contract names through `self.*`/`old.*`/`result.*` refs and `db.*` `where` keys. Only existing Field nodes are returned. */
export function fieldsNamedByContract(graph: Pick<Graph, "nodes">, contract: ContractNode): FieldId[] {
  if (!contract.expr) return [];
  const nodes = graph.nodes;
  const out = new Set<FieldId>();
  const owner = nodes[contract.of];
  const subjectEntity: EntityId | null =
    owner?.kind === "Entity" ? (owner.id as EntityId) : owner?.kind === "Action" ? (owner.subject?.entity ?? null) : null;
  const resultEntity: EntityId | null =
    (owner?.kind === "Action" || owner?.kind === "Query") && "entity" in owner.output ? owner.output.entity : null;
  const resolvePath = (entity: EntityId | null, segments: readonly string[]): void => {
    let current = entity;
    for (const seg of segments) {
      if (!current) return;
      const fid = fieldId(current, seg);
      const field = nodes[fid];
      if (!field || field.kind !== "Field") return;
      out.add(fid);
      current = field.type.kind === "relation" ? field.type.to : null;
    }
  };
  for (const ref of collectRefs(contract.expr)) {
    const root = refRoot(ref);
    if (root === "self" || root === "old") resolvePath(subjectEntity, refSegments(ref));
    else if (root === "result") resolvePath(resultEntity, refSegments(ref));
  }
  const byClientName = new Map<string, EntityId>();
  for (const n of Object.values(nodes)) if (n.kind === "Entity") byClientName.set(n.clientName, n.id as EntityId);
  for (const pred of collectDbPredicates(contract.expr)) {
    const entity = byClientName.get(pred.model) ?? null;
    for (const key of Object.keys(pred.where)) resolvePath(entity, key.split("."));
  }
  return uniqueSorted([...out]);
}

/** The Entity a Field belongs to, from its id. */
export function entityOfField(id: FieldId): EntityId | null {
  return parseFieldId(id)?.entity ?? null;
}
