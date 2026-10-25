/**
 * Generated Test nodes and their `verifiedBy` edges, derived from the graph (SPEC-IR §4 Test, D-13).
 * The compiler adds these to the graph after rules and before `dependsOn`/health.
 */

import { kindOf, type Edge, type Graph, type NodeId, type Provenance, type TestNode } from "@averri/ir";
import { planTests } from "./generate.js";
import type { GenerateOptions, PlannedSuite } from "./types.js";

/** Node kinds allowed as the source of a `verifiedBy` edge (types.ts EDGE_KINDS table). */
const VERIFIED_BY_SOURCES = new Set(["Action", "Query", "Policy", "Contract", "Event", "Workflow", "Integration", "Exposure"]);

function provenanceFor(graph: Graph, owner: NodeId): Provenance {
  const n = graph.nodes[owner];
  if (n && (n.provenance.origin === "declared" || n.provenance.origin === "verified")) return { origin: "declared", declaredAt: n.provenance.declaredAt };
  return { origin: "extracted", extractor: "vitest", confidence: 1, evidence: [{ kind: "test", note: `derived from ${owner} by averri testgen` }] };
}

export function testNodeOf(graph: Graph, suite: PlannedSuite): TestNode {
  const summary = `generated ${suite.suite} suite for ${suite.owner}${suite.todos.length > 0 ? ` (${suite.todos.length} todo)` : ""}`.slice(0, 200);
  return {
    id: suite.id,
    kind: "Test",
    name: suite.id.slice("Test:".length),
    summary,
    provenance: provenanceFor(graph, suite.owner),
    src: null,
    generated: true,
    suite: suite.suite,
    file: suite.file,
    title: suite.title,
    covers: [...suite.covers],
    lastResult: null,
    sourceHash: suite.sourceHash,
  };
}

export interface DerivedTests {
  nodes: TestNode[];
  /** `verifiedBy` edges from every covered node whose kind may carry one, to the Test node. */
  edges: Edge[];
}

export function deriveTestNodes(graph: Graph, options: GenerateOptions = {}): DerivedTests {
  const suites = planTests(graph, options);
  const nodes = suites.map((s) => testNodeOf(graph, s));
  const edges: Edge[] = [];
  for (const [i, s] of suites.entries()) {
    const test = nodes[i] as TestNode;
    for (const from of s.covers) {
      if (!VERIFIED_BY_SOURCES.has(kindOf(from))) continue;
      if (!graph.nodes[from]) continue;
      edges.push({ kind: "verifiedBy", from, to: test.id, provenance: test.provenance });
    }
  }
  return { nodes, edges };
}
