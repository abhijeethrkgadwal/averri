import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  NODE_KINDS,
  compareDiagnosticIds,
  computeCounts,
  graphIdentityJson,
  nodeKindOfId,
  nodesOfKind,
  serializeGraph,
  sortGraph,
  sortedNodeIds,
  sumCounts,
  validateGraph,
  type Edge,
  type Graph,
  type Node,
} from "../src/index.js";
import { clone, exampleGraph } from "./fixtures.js";

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function permuteGraph(g: Graph, seed: number): Graph {
  const nodes: Record<string, Node> = {};
  for (const id of shuffle(Object.keys(g.nodes), seed)) nodes[id] = g.nodes[id as keyof typeof g.nodes]!;
  return { meta: g.meta, nodes: nodes as Graph["nodes"], edges: shuffle(g.edges, seed + 1), diagnostics: shuffle(g.diagnostics, seed + 2) };
}

describe("sortGraph", () => {
  it("sorts node keys, edges by (kind, from, to) and diagnostics by id", () => {
    const g = permuteGraph(exampleGraph(), 7);
    const s = sortGraph(g);
    const ids = Object.keys(s.nodes);
    expect(ids).toEqual(ids.slice().sort());
    for (let i = 1; i < s.edges.length; i++) {
      const a = s.edges[i - 1]!;
      const b = s.edges[i]!;
      expect([a.kind, a.from, a.to].join("\u0000") <= [b.kind, b.from, b.to].join("\u0000")).toBe(true);
    }
    expect(s.diagnostics.map((d) => d.id)).toEqual(["D-0001", "D-0002", "D-0003"]);
    expect(validateGraph(s)).toBeTruthy();
  });
  it("does not mutate the input", () => {
    const g = permuteGraph(exampleGraph(), 3);
    const before = JSON.stringify(g);
    sortGraph(g);
    expect(JSON.stringify(g)).toBe(before);
  });
  it("dedupes edges keeping the higher provenance", () => {
    const g = exampleGraph();
    const e = g.edges.find((x) => x.kind === "writes")!;
    const dup: Edge = { ...e, provenance: { origin: "extracted", extractor: "ts-handler", confidence: 0.7, evidence: [] } };
    const s = sortGraph({ ...g, edges: [dup, ...g.edges] });
    const writes = s.edges.filter((x) => x.kind === "writes");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.provenance.origin).toBe("verified");
  });
});

describe("serializeGraph", () => {
  it("is byte-identical for any permutation of nodes/edges/diagnostics", () => {
    const g = exampleGraph();
    const reference = serializeGraph(g);
    expect(reference.endsWith("\n")).toBe(true);
    expect(reference).not.toContain("\r");
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (seed) => {
        expect(serializeGraph(permuteGraph(g, seed))).toBe(reference);
      }),
      { numRuns: 25 },
    );
  });
  it("round-trips through JSON.parse + validateGraph", () => {
    const g = exampleGraph();
    const parsed = validateGraph(JSON.parse(serializeGraph(g)));
    expect(serializeGraph(parsed)).toBe(serializeGraph(g));
  });
  it("graphIdentityJson ignores builtAt and root only", () => {
    const g = exampleGraph();
    const h = clone(g);
    h.meta.builtAt = "2030-01-01T00:00:00.000Z";
    h.meta.root = "/elsewhere";
    expect(graphIdentityJson(h)).toBe(graphIdentityJson(g));
    h.meta.contentHash = "other";
    expect(graphIdentityJson(h)).not.toBe(graphIdentityJson(g));
  });
});

describe("counts and helpers", () => {
  it("computeCounts has every kind and sums to the node count", () => {
    const g = exampleGraph();
    const counts = computeCounts(g.nodes);
    for (const k of NODE_KINDS) expect(typeof counts[k]).toBe("number");
    expect(sumCounts(counts)).toBe(Object.keys(g.nodes).length);
    expect(counts.Entity).toBe(3);
    expect(counts.Contract).toBe(6);
    expect(computeCounts({}).Entity).toBe(0);
  });
  it("nodesOfKind returns typed nodes in id order", () => {
    const g = exampleGraph();
    const exposures = nodesOfKind(g, "Exposure");
    expect(exposures.map((e) => e.id)).toEqual(["Exposure:hono:src/routes/health.ts:3:4", "Exposure:hono:src/routes/teams.ts:41:4", "Exposure:hono:src/routes/teams.ts:50:4"]);
    expect(exposures[0]!.router).toBe("hono");
    expect(sortedNodeIds(g.nodes)[0]).toBe("Action:Team.inviteMember");
  });
  it("compareDiagnosticIds orders numerically", () => {
    expect(["D-0010", "D-0002", "D-0001"].sort(compareDiagnosticIds)).toEqual(["D-0001", "D-0002", "D-0010"]);
    expect(["D-x", "D-0001"].sort(compareDiagnosticIds)).toEqual(["D-0001", "D-x"]);
  });
  it("nodeKindOfId", () => {
    expect(nodeKindOfId("Entity:X")).toBe("Entity");
    expect(nodeKindOfId("nope")).toBeNull();
  });
});
