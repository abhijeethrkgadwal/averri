/**
 * `sourceHash`: the hash of the declaration content a generated file derives from (SPEC-IR §4 Test,
 * D-13). It is computed from the GRAPH, so the compiler can derive Test nodes with the same hash
 * without generating, and A6001 compares it with the `hash:` header on disk.
 *
 * Volatile node properties (`src`, `provenance`, `summary`, `ratios`, `lastResult`) are excluded:
 * moving a declaration does not change the tests it derives.
 */

import { collectDbModels, sourcesOf, stableHash, type Graph, type Node, type NodeId } from "@averri/ir";
import { SchemaFacts } from "./schema.js";

const VOLATILE = new Set(["src", "provenance", "summary", "ratios", "lastResult"]);

export function stripVolatile(n: Node): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(n).sort()) if (!VOLATILE.has(key)) out[key] = (n as unknown as Record<string, unknown>)[key];
  return out;
}

function entityInputs(graph: Graph, facts: SchemaFacts, id: string, into: Map<string, unknown>): void {
  const entity = facts.entity(id);
  if (!entity || into.has(entity.id)) return;
  into.set(entity.id, stripVolatile(entity));
  for (const f of facts.fields(entity)) into.set(f.id, stripVolatile(f));
  for (const c of entity.invariants) {
    const node = graph.nodes[c];
    if (node) into.set(c, stripVolatile(node));
  }
}

function actionInputs(graph: Graph, facts: SchemaFacts, n: Node, into: Map<string, unknown>): void {
  if (n.kind !== "Action" && n.kind !== "Query") return;
  into.set(n.id, stripVolatile(n));
  const exprs: Node[] = [];
  if (n.kind === "Action") {
    for (const c of n.contracts) {
      const node = graph.nodes[c];
      if (node) {
        into.set(c, stripVolatile(node));
        exprs.push(node);
      }
    }
    if (n.subject) entityInputs(graph, facts, n.subject.entity, into);
    for (const w of n.effects.verified.writes) entityInputs(graph, facts, w, into);
  }
  if (n.policy) {
    const policy = graph.nodes[n.policy];
    if (policy && policy.kind === "Policy") {
      into.set(policy.id, stripVolatile(policy));
      const allow = graph.nodes[policy.allow];
      if (allow) {
        into.set(allow.id, stripVolatile(allow));
        exprs.push(allow);
      }
    }
  }
  if ("entity" in n.output) entityInputs(graph, facts, n.output.entity, into);
  for (const c of exprs) {
    if (c.kind !== "Contract" || !c.expr) continue;
    for (const model of collectDbModels(c.expr)) {
      const entity = facts.entityByClient(model);
      if (entity) entityInputs(graph, facts, entity.id, into);
    }
  }
}

/** Writers of an entity: Actions with a `writes` edge to it or listing it in `effects.verified.writes`, sorted. */
export function writersOf(graph: Graph, entityId: NodeId): NodeId[] {
  const ids = new Set<NodeId>();
  for (const from of sourcesOf(graph.edges, entityId, "writes")) if (graph.nodes[from]?.kind === "Action") ids.add(from);
  for (const id of Object.keys(graph.nodes) as NodeId[]) {
    const n = graph.nodes[id];
    if (n?.kind === "Action" && n.effects.verified.writes.includes(entityId as `Entity:${string}`)) ids.add(id);
  }
  return [...ids].sort();
}

/** Workflows consuming an event (`on === event` or a `consumedBy` edge), sorted. */
export function consumersOf(graph: Graph, eventId: NodeId): NodeId[] {
  const ids = new Set<NodeId>();
  for (const id of Object.keys(graph.nodes) as NodeId[]) {
    const n = graph.nodes[id];
    if (n?.kind === "Workflow" && n.on === eventId) ids.add(id);
  }
  for (const e of graph.edges) if (e.kind === "consumedBy" && e.from === eventId && graph.nodes[e.to]?.kind === "Workflow") ids.add(e.to);
  return [...ids].sort();
}

/** The canonical derivation inputs of an owner's generated file (a sorted id -> stripped node map). */
export function derivationInputs(graph: Graph, owner: NodeId): Record<string, unknown> {
  const facts = new SchemaFacts(graph);
  const into = new Map<string, unknown>();
  const n = graph.nodes[owner];
  if (!n) return {};
  switch (n.kind) {
    case "Action":
    case "Query":
      actionInputs(graph, facts, n, into);
      break;
    case "Entity":
      entityInputs(graph, facts, n.id, into);
      for (const w of writersOf(graph, n.id)) {
        const writer = graph.nodes[w];
        if (writer) actionInputs(graph, facts, writer, into);
      }
      break;
    case "Event":
      into.set(n.id, stripVolatile(n));
      for (const w of consumersOf(graph, n.id)) {
        const wf = graph.nodes[w];
        if (wf) into.set(w, stripVolatile(wf));
      }
      break;
    case "Integration": {
      into.set(n.id, stripVolatile(n));
      const exposure = n.webhook?.exposure ? graph.nodes[n.webhook.exposure] : null;
      if (exposure && exposure.kind === "Exposure") into.set("webhook.exposure", { method: exposure.method, path: exposure.path });
      break;
    }
    default:
      into.set(n.id, stripVolatile(n));
  }
  const out: Record<string, unknown> = {};
  for (const key of [...into.keys()].sort()) out[key] = into.get(key);
  return out;
}

/** sha256 hex of the canonical derivation inputs. */
export function sourceHashOf(graph: Graph, owner: NodeId): string {
  return stableHash(derivationInputs(graph, owner));
}
