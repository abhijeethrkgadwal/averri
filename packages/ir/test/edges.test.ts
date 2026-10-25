import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  EDGE_KINDS,
  addEdge,
  compareEdges,
  compareProvenance,
  dedupeEdges,
  edgeKey,
  edgesFrom,
  edgesOfKind,
  edgesTo,
  edgesTouching,
  groupEdgesByKind,
  hasEdge,
  isEdgeKind,
  minProvenance,
  parseEdgeKey,
  partitionDanglingEdges,
  provenanceRank,
  sortEdges,
  sourcesOf,
  targetsOf,
  uniqueSorted,
  type Edge,
  type Provenance,
} from "../src/index.js";
import { declared, edge, exampleGraph, extracted, verified } from "./fixtures.js";

describe("edgeKey", () => {
  it("formats and parses", () => {
    const e = edge("writes", "Action:Team.inviteMember", "Entity:Invitation");
    expect(edgeKey(e)).toBe("writes:Action:Team.inviteMember->Entity:Invitation");
    expect(parseEdgeKey(edgeKey(e))).toEqual({ kind: "writes", from: "Action:Team.inviteMember", to: "Entity:Invitation" });
    expect(parseEdgeKey("flies:A->B")).toBeNull();
    expect(parseEdgeKey("writes:A")).toBeNull();
    expect(parseEdgeKey("writes:->B")).toBeNull();
    expect(parseEdgeKey("writes:A->")).toBeNull();
    expect(isEdgeKind("reads")).toBe(true);
    expect(isEdgeKind("flies")).toBe(false);
  });
});

describe("provenance ranking", () => {
  it("verified > declared > extracted", () => {
    expect(provenanceRank(extracted())).toBe(0);
    expect(provenanceRank(declared)).toBe(1);
    expect(provenanceRank(verified)).toBe(2);
    expect(provenanceRank("declared")).toBe(1);
    expect(compareProvenance(verified, declared)).toBeGreaterThan(0);
    expect(compareProvenance("extracted", "declared")).toBeLessThan(0);
    expect(minProvenance(verified, extracted(0.5))).toEqual(extracted(0.5));
    expect(minProvenance(declared, verified)).toBe(declared);
  });
});

describe("dedupeEdges / addEdge", () => {
  const a = edge("reads", "Query:Team.listMembers", "Entity:Membership", extracted(0.8), { note: "x", only: "low" });
  const b = edge("reads", "Query:Team.listMembers", "Entity:Membership", verified, { note: "y" });
  it("keeps the higher provenance and merges attrs (higher wins on conflicts)", () => {
    const out = dedupeEdges([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.provenance.origin).toBe("verified");
    expect(out[0]!.attrs).toEqual({ note: "y", only: "low" });
    expect(dedupeEdges([b, a])[0]!.provenance.origin).toBe("verified");
  });
  it("first occurrence wins on equal provenance", () => {
    const c = { ...a, provenance: declared, attrs: { note: "first" } };
    const d = { ...a, provenance: declared, attrs: { note: "second", extra: "e" } };
    expect(dedupeEdges([c, d])[0]!.attrs).toEqual({ note: "first", extra: "e" });
  });
  it("omits attrs when neither edge has any", () => {
    const e1 = edge("reads", "Query:Team.listMembers", "Entity:Membership", declared);
    const e2 = edge("reads", "Query:Team.listMembers", "Entity:Membership", verified);
    expect("attrs" in dedupeEdges([e1, e2])[0]!).toBe(false);
  });
  it("addEdge does not mutate and dedupes", () => {
    const list = [a];
    const out = addEdge(list, b);
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(a);
    expect(out).toHaveLength(1);
    expect(out[0]!.provenance.origin).toBe("verified");
    const out2 = addEdge(out, edge("writes", "Action:Team.inviteMember", "Entity:Invitation"));
    expect(out2).toHaveLength(2);
  });
  it("property: dedupe is idempotent and keeps max provenance per key", () => {
    const prov = fc.constantFrom<Provenance>(extracted(0.5), declared, verified);
    const edgeArb = fc.record({ kind: fc.constantFrom(...EDGE_KINDS), from: fc.constantFrom("Entity:A", "Entity:B"), to: fc.constantFrom("Entity:A", "Entity:B", "Entity:C"), provenance: prov }) as fc.Arbitrary<Edge>;
    fc.assert(
      fc.property(fc.array(edgeArb, { maxLength: 20 }), (edges) => {
        const once = dedupeEdges(edges);
        expect(dedupeEdges(once)).toEqual(once);
        expect(new Set(once.map(edgeKey)).size).toBe(once.length);
        for (const e of once) {
          const max = Math.max(...edges.filter((x) => edgeKey(x) === edgeKey(e)).map((x) => provenanceRank(x.provenance)));
          expect(provenanceRank(e.provenance)).toBe(max);
        }
        expect(sortEdges(once)).toEqual(sortEdges(dedupeEdges(edges.slice().reverse())));
      }),
    );
  });
});

describe("queries", () => {
  const g = exampleGraph();
  it("by kind / endpoint", () => {
    expect(edgesOfKind(g.edges, "authorizes")).toHaveLength(2);
    expect(edgesFrom(g.edges, "Policy:Team.OwnerOrAdmin").map(edgeKey).sort()).toEqual([
      "authorizes:Policy:Team.OwnerOrAdmin->Action:Team.inviteMember",
      "authorizes:Policy:Team.OwnerOrAdmin->Query:Team.listMembers",
      "reads:Policy:Team.OwnerOrAdmin->Entity:Membership",
    ]);
    expect(edgesFrom(g.edges, "Policy:Team.OwnerOrAdmin", "reads")).toHaveLength(1);
    expect(edgesTo(g.edges, "Entity:Membership", "reads")).toHaveLength(3);
    expect(edgesTo(g.edges, "Entity:Membership")).toHaveLength(3);
    expect(edgesTo(g.edges, "Module:prisma/schema.prisma")).toHaveLength(3);
    expect(edgesTouching(g.edges, "Event:MemberInvited").map((e) => e.kind).sort()).toEqual(["consumedBy", "emits"]);
    expect(edgesTouching(g.edges, "Event:MemberInvited", "emits")).toHaveLength(1);
    expect(hasEdge(g.edges, "emits", "Action:Team.inviteMember", "Event:MemberInvited")).toBe(true);
    expect(hasEdge(g.edges, "emits", "Action:Team.inviteMember", "Event:Orphan")).toBe(false);
    expect(targetsOf(g.edges, "Policy:Team.OwnerOrAdmin", "authorizes")).toEqual(["Action:Team.inviteMember", "Query:Team.listMembers"]);
    expect(sourcesOf(g.edges, "Entity:Membership", "reads")).toEqual(["Contract:Team.inviteMember.requires.notAlreadyMember", "Policy:Team.OwnerOrAdmin", "Query:Team.listMembers"]);
  });
  it("groupEdgesByKind presents both directions and excludes dependsOn", () => {
    const edges = [...g.edges, edge("dependsOn", "Exposure:hono:src/routes/teams.ts:41:4", "Action:Team.inviteMember")];
    const grouped = groupEdgesByKind(edges, "Action:Team.inviteMember");
    expect(grouped.authorizes).toEqual(["Policy:Team.OwnerOrAdmin"]);
    expect(grouped.exposes).toEqual(["Exposure:hono:src/routes/teams.ts:41:4"]);
    expect(grouped.constrains).toHaveLength(4);
    expect(grouped.writes).toEqual(["Entity:Invitation"]);
    expect(grouped.verifiedBy).toEqual(["Test:gen/Team.inviteMember.auth-matrix", "Test:tests/members.test.ts:17"]);
    expect(grouped.dependsOn).toBeUndefined();
    expect(groupEdgesByKind(edges, "Entity:Ghost")).toEqual({});
  });
  it("partitionDanglingEdges", () => {
    const dangling = edge("reads", "Action:Team.inviteMember", "Entity:Ghost");
    const r = partitionDanglingEdges({ nodes: g.nodes, edges: [...g.edges, dangling] });
    expect(r.dangling).toEqual([dangling]);
    expect(r.valid).toHaveLength(g.edges.length);
  });
  it("compareEdges / sortEdges / uniqueSorted", () => {
    const sorted = sortEdges(g.edges.slice().reverse());
    expect(sorted.map(edgeKey)).toEqual(sortEdges(g.edges).map(edgeKey));
    expect(compareEdges(edge("reads", "Entity:a", "Entity:b"), edge("writes", "Entity:a", "Entity:b"))).toBeLessThan(0);
    expect(compareEdges(edge("reads", "Entity:a", "Entity:b", verified), edge("reads", "Entity:a", "Entity:b", declared))).toBeLessThan(0);
    expect(uniqueSorted(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});
