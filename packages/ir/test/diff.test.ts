import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_DIFF_IGNORE,
  GraphDiffSchema,
  contractsWeakened,
  diffGraphs,
  diffValues,
  opsTouching,
  renameKey,
  summarizeGraphDiff,
  type ActionNode,
  type ContractNode,
  type Edge,
  type Graph,
  type GraphDiffOp,
  type Node,
} from "../src/index.js";
import { action, clone, contract, edge, event, exampleGraph, exposure, graph, test } from "./fixtures.js";

function ops(diff: { ops: GraphDiffOp[] }, op?: GraphDiffOp["op"]): GraphDiffOp[] {
  return op ? diff.ops.filter((o) => o.op === op) : diff.ops;
}

function head(mutate: (g: Graph) => void): Graph {
  const g = clone(exampleGraph());
  mutate(g);
  g.meta.contentHash = "hash-head";
  g.meta.commit = "def456";
  // keep counts honest after node edits
  const counts = Object.fromEntries(Object.keys(g.meta.counts).map((k) => [k, 0])) as Graph["meta"]["counts"];
  for (const n of Object.values(g.nodes)) counts[n.kind] += 1;
  g.meta.counts = counts;
  return g;
}

describe("diffGraphs — basics", () => {
  it("identical graphs produce no ops and carry both metas", () => {
    const g = exampleGraph();
    const d = diffGraphs(g, g);
    expect(d.ops).toEqual([]);
    expect(d.base).toEqual({ commit: "abc123", contentHash: "hash-base" });
    expect(GraphDiffSchema.safeParse(d).success).toBe(true);
  });
  it("ignores src/provenance/summary/lastResult by default, reports them on request", () => {
    const h = head((g) => {
      const a = g.nodes["Action:Team.inviteMember"] as ActionNode;
      a.src = { file: a.src!.file, range: [[30, 0], [56, 3]] };
      a.summary = "moved";
      a.provenance = { origin: "declared", declaredAt: a.src };
      (g.nodes["Test:tests/members.test.ts:17"] as { lastResult: unknown }).lastResult = { status: "passed", at: "now" };
    });
    expect(diffGraphs(exampleGraph(), h).ops).toEqual([]);
    const all = diffGraphs(exampleGraph(), h, { ignore: [] });
    expect(all.ops.map((o) => `${o.node} ${o.target}`)).toEqual([
      "Action:Team.inviteMember provenance.declaredAt.range",
      "Action:Team.inviteMember provenance.origin",
      "Action:Team.inviteMember provenance.verifiers",
      "Action:Team.inviteMember provenance.evidence",
      "Action:Team.inviteMember src.range",
      "Action:Team.inviteMember summary",
      "Test:tests/members.test.ts:17 lastResult",
    ].sort());
    expect(DEFAULT_DIFF_IGNORE).toEqual(["src", "provenance", "summary", "lastResult"]);
  });
  it("add / remove nodes and edges", () => {
    const h = head((g) => {
      const q = g.nodes["Query:Team.listMembers"]!;
      delete (g.nodes as Record<string, unknown>)["Query:Team.listMembers"];
      g.edges = g.edges.filter((e) => e.from !== q.id && e.to !== q.id);
      const ev = event("TeamRenamed");
      g.nodes[ev.id] = ev;
      g.edges.push(edge("emits", "Action:Team.inviteMember", ev.id));
    });
    const d = diffGraphs(exampleGraph(), h);
    expect(ops(d, "remove")).toEqual([{ op: "remove", node: "Query:Team.listMembers" }]);
    expect(ops(d, "add")).toEqual([{ op: "add", node: "Event:TeamRenamed" }]);
    expect(ops(d, "remove-edge").map((o) => o.target)).toEqual([
      "authorizes:Policy:Team.OwnerOrAdmin->Query:Team.listMembers",
      "reads:Query:Team.listMembers->Entity:Membership",
    ]);
    expect(ops(d, "remove-edge")[0]!.node).toBe("Policy:Team.OwnerOrAdmin");
    expect(ops(d, "add-edge")).toEqual([{ op: "add-edge", node: "Action:Team.inviteMember", target: "emits:Action:Team.inviteMember->Event:TeamRenamed" }]);
    expect(summarizeGraphDiff(d)).toBe("-1 query, +1 event");
  });
  it("change ops use dotted paths with before/after; arrays are leaves", () => {
    const h = head((g) => {
      const a = g.nodes["Action:Team.inviteMember"] as ActionNode;
      a.route = { ...a.route!, path: "/teams/:teamId/invites" };
      a.effects.declared = ["db:write"];
      a.intent = undefined;
      (g.nodes["Entity:Invitation"] as { uniques: string[][] }).uniques = [["teamId", "email"]];
    });
    const d = diffGraphs(exampleGraph(), h);
    expect(ops(d, "change")).toEqual([
      { op: "change", node: "Action:Team.inviteMember", target: "effects.declared", before: ["db:write", "event:emit"], after: ["db:write"] },
      { op: "change", node: "Action:Team.inviteMember", target: "intent", before: "An owner or admin invites a person by email.", after: undefined },
      { op: "change", node: "Action:Team.inviteMember", target: "route.path", before: "/teams/:teamId/invitations", after: "/teams/:teamId/invites" },
      { op: "change", node: "Entity:Invitation", target: "uniques", before: [], after: [["teamId", "email"]] },
    ]);
    expect(summarizeGraphDiff(d)).toBe("~1 entity, ~1 action");
    expect(summarizeGraphDiff(d, ["Entity:Invitation"])).toBe("~1 entity");
    expect(summarizeGraphDiff(d, new Set(["Event:Orphan"]))).toBe("no changes");
  });
  it("dependsOn edges never appear", () => {
    const h = head((g) => {
      g.edges.push(edge("dependsOn", "Action:Team.inviteMember", "Entity:Invitation"));
    });
    expect(diffGraphs(exampleGraph(), h).ops).toEqual([]);
  });
});

describe("diffGraphs — contracts", () => {
  it("add-contract / remove-contract attributed to the owner", () => {
    const h = head((g) => {
      delete (g.nodes as Record<string, unknown>)["Contract:Team.inviteMember.ensures.eventEmitted"];
      g.edges = g.edges.filter((e) => e.from !== "Contract:Team.inviteMember.ensures.eventEmitted");
      const c = contract("Contract:Team.inviteMember.requires.roleValid", "Action:Team.inviteMember", "requires", { op: "in", lhs: { ref: "input.role" }, rhs: { lit: ["member"] } });
      g.nodes[c.id] = c;
      g.edges.push(edge("constrains", c.id, "Action:Team.inviteMember"));
    });
    const d = diffGraphs(exampleGraph(), h);
    expect(ops(d, "remove-contract")).toEqual([
      { op: "remove-contract", node: "Action:Team.inviteMember", target: "Contract:Team.inviteMember.ensures.eventEmitted", before: { tier: "expr", expr: { op: "emitted", event: "Event:MemberInvited" } } },
    ]);
    expect(ops(d, "add-contract")).toMatchObject([{ op: "add-contract", node: "Action:Team.inviteMember", target: "Contract:Team.inviteMember.requires.roleValid" }]);
    expect(ops(d, "add")).toEqual([]);
    expect(ops(d, "remove")).toEqual([]);
    expect(contractsWeakened(d)).toEqual([{ contract: "Contract:Team.inviteMember.ensures.eventEmitted", op: "remove-contract" }]);
    expect(summarizeGraphDiff(d)).toBe("+1 contract, -1 contract");
    expect(summarizeGraphDiff(d, ["Contract:Team.inviteMember.ensures.eventEmitted"])).toBe("-1 contract");
  });
  it("weaken / strengthen / undecided change of a contract AST", () => {
    const id = "Contract:Team.OwnerOrAdmin.allow";
    const weaker = head((g) => {
      const c = g.nodes[id] as ContractNode;
      c.expr = { op: "db.exists", model: "membership", where: { teamId: { ref: "input.teamId" }, userId: { ref: "actor.id" } } };
    });
    const dw = diffGraphs(exampleGraph(), weaker);
    expect(dw.ops).toHaveLength(1);
    expect(dw.ops[0]).toMatchObject({ op: "weaken-contract", node: "Policy:Team.OwnerOrAdmin", target: id });
    expect(dw.ops[0]!.before).toMatchObject({ tier: "predicate" });
    expect(contractsWeakened(dw)).toEqual([{ contract: id, op: "weaken-contract" }]);
    expect(summarizeGraphDiff(dw)).toBe("~1 contract");

    const stronger = head((g) => {
      const c = g.nodes[id] as ContractNode;
      c.expr = { op: "db.exists", model: "membership", where: { teamId: { ref: "input.teamId" }, userId: { ref: "actor.id" }, role: { in: { lit: ["owner"] } } } };
    });
    expect(diffGraphs(exampleGraph(), stronger).ops).toMatchObject([{ op: "strengthen-contract", node: "Policy:Team.OwnerOrAdmin", target: id }]);
    expect(contractsWeakened(diffGraphs(exampleGraph(), stronger))).toEqual([]);

    const undecided = head((g) => {
      const c = g.nodes[id] as ContractNode;
      c.expr = { op: "eq", lhs: { ref: "actor.role" }, rhs: { lit: "owner" } };
      c.tier = "expr";
    });
    const du = diffGraphs(exampleGraph(), undecided);
    expect(du.ops).toMatchObject([{ op: "change", node: "Policy:Team.OwnerOrAdmin", target: id, before: { tier: "predicate" }, after: { tier: "expr" } }]);
    expect(contractsWeakened(du)).toEqual([{ contract: id, op: "change" }]);

    const guarded = head((g) => {
      const c = g.nodes[id] as ContractNode;
      c.expr = null;
      c.tier = "guard";
      c.opaque = true;
      (g.nodes["Policy:Team.OwnerOrAdmin"] as { tier: string }).tier = "guard";
    });
    const dg = diffGraphs(exampleGraph(), guarded);
    expect(dg.ops.map((o) => [o.op, o.node, o.target])).toEqual([
      ["weaken-contract", "Policy:Team.OwnerOrAdmin", id],
      ["change", "Policy:Team.OwnerOrAdmin", "tier"],
    ]);
  });
  it("non-AST contract fields are plain change ops on the contract node", () => {
    const h = head((g) => {
      (g.nodes["Contract:Team.inviteMember.ensures.pendingForEmail"] as ContractNode).message = "must stay pending";
    });
    const d = diffGraphs(exampleGraph(), h);
    expect(d.ops).toEqual([{ op: "change", node: "Contract:Team.inviteMember.ensures.pendingForEmail", target: "message", before: undefined, after: "must stay pending" }]);
    expect(contractsWeakened(d)).toEqual([]);
  });
});

describe("diffGraphs — renames", () => {
  function renameAction(g: Graph, from: string, to: string): void {
    const old = g.nodes[from as keyof typeof g.nodes] as ActionNode;
    const q = to.slice("Action:".length);
    const renamed: ActionNode = { ...old, id: to as ActionNode["id"], name: q, contracts: old.contracts.map((c) => c.replace(from.slice("Action:".length), q) as `Contract:${string}`) };
    delete (g.nodes as Record<string, unknown>)[from];
    g.nodes[renamed.id] = renamed;
    for (const id of Object.keys(g.nodes)) {
      const n = g.nodes[id as keyof typeof g.nodes]!;
      if (n.kind === "Contract" && n.of === from) {
        const nid = id.replace(from.slice("Action:".length), q);
        delete (g.nodes as Record<string, unknown>)[id];
        g.nodes[nid as `Contract:${string}`] = { ...n, id: nid as `Contract:${string}`, of: to as `Action:${string}` };
      }
      if (n.kind === "Test" && n.generated && id.includes(from.slice("Action:".length))) {
        const nid = id.replace(from.slice("Action:".length), q);
        delete (g.nodes as Record<string, unknown>)[id];
        g.nodes[nid as `Test:${string}`] = { ...n, id: nid as `Test:${string}`, covers: n.covers.map((c) => (c === from ? (to as `Action:${string}`) : c)) };
      }
      if (n.kind === "Test" && !n.generated) n.covers = n.covers.map((c) => (c === from ? (to as `Action:${string}`) : c));
      if (n.kind === "Policy") n.appliesTo = n.appliesTo.map((c) => (c === from ? (to as `Action:${string}`) : c));
      if (n.kind === "Exposure" && n.boundTo === from) n.boundTo = to as `Action:${string}`;
    }
    const map = (id: string): string => id.replace(from.slice("Action:".length), q);
    g.edges = g.edges.map((e) => ({ ...e, from: map(e.from) as Edge["from"], to: map(e.to) as Edge["to"] }));
  }
  it("same handler symbol => rename op, contracts and generated tests follow, no add/remove", () => {
    const h = head((g) => renameAction(g, "Action:Team.inviteMember", "Action:Team.invite"));
    const d = diffGraphs(exampleGraph(), h);
    const renames = ops(d, "rename").map((o) => [o.node, o.target]);
    expect(renames).toEqual([
      ["Action:Team.invite", "Action:Team.inviteMember"],
      ["Contract:Team.invite.ensures.eventEmitted", "Contract:Team.inviteMember.ensures.eventEmitted"],
      ["Contract:Team.invite.ensures.pendingForEmail", "Contract:Team.inviteMember.ensures.pendingForEmail"],
      ["Contract:Team.invite.requires.emailDomainAllowed", "Contract:Team.inviteMember.requires.emailDomainAllowed"],
      ["Contract:Team.invite.requires.notAlreadyMember", "Contract:Team.inviteMember.requires.notAlreadyMember"],
      ["Test:gen/Team.invite.auth-matrix", "Test:gen/Team.inviteMember.auth-matrix"],
    ]);
    expect(ops(d, "add")).toEqual([]);
    expect(ops(d, "remove")).toEqual([]);
    expect(ops(d, "add-contract")).toEqual([]);
    expect(ops(d, "remove-contract")).toEqual([]);
    expect(ops(d, "add-edge")).toEqual([]);
    expect(ops(d, "remove-edge")).toEqual([]);
    // the only changes are the id-bearing mirror fields
    expect(ops(d, "change").map((o) => `${o.node} ${o.target}`)).toEqual([
      "Action:Team.invite contracts",
      "Contract:Team.invite.ensures.eventEmitted of",
      "Contract:Team.invite.ensures.pendingForEmail of",
      "Contract:Team.invite.requires.emailDomainAllowed of",
      "Contract:Team.invite.requires.notAlreadyMember of",
      "Exposure:hono:src/routes/teams.ts:41:4 boundTo",
      "Policy:Team.OwnerOrAdmin appliesTo",
      "Test:gen/Team.invite.auth-matrix covers",
      "Test:tests/members.test.ts:17 covers",
    ]);
    expect(summarizeGraphDiff(d)).toContain("~1 action");
  });
  it("tie rule: a handler shared by two declarations on either side yields no rename", () => {
    const base = clone(exampleGraph());
    const twin = action("Team.inviteTwin", { handler: { file: "src/members/inviteMember.ts", symbol: "InviteMember.run" } });
    base.nodes[twin.id] = twin;
    base.meta.counts.Action = 2;
    const h = clone(base);
    renameAction(h, "Action:Team.inviteMember", "Action:Team.invite");
    const d = diffGraphs(base, h);
    expect(ops(d, "rename")).toEqual([]);
    expect(ops(d, "remove")).toEqual([{ op: "remove", node: "Action:Team.inviteMember" }, { op: "remove", node: "Test:gen/Team.inviteMember.auth-matrix" }]);
    expect(ops(d, "add")).toEqual([{ op: "add", node: "Action:Team.invite" }, { op: "add", node: "Test:gen/Team.invite.auth-matrix" }]);
    expect(ops(d, "remove-contract")).toHaveLength(4);
    expect(ops(d, "add-contract")).toHaveLength(4);
  });
  it("no handler => no rename key", () => {
    const h = head((g) => {
      renameAction(g, "Action:Team.inviteMember", "Action:Team.invite");
      (g.nodes["Action:Team.invite"] as ActionNode).handler = null;
    });
    const d = diffGraphs(exampleGraph(), h);
    expect(ops(d, "rename")).toEqual([]);
    expect(renameKey((h.nodes as Record<string, Node>)["Action:Team.invite"]!)).toBeNull();
    expect(renameKey(exampleGraph().nodes["Action:Team.inviteMember"]!)).toBe("Action|src/members/inviteMember.ts|InviteMember.run");
    expect(renameKey(exampleGraph().nodes["Entity:User"]!)).toBeNull();
  });
  it("exposures rename by src.file + method + path when the registration moves", () => {
    const h = head((g) => {
      const old = g.nodes["Exposure:hono:src/routes/teams.ts:41:4"]!;
      delete (g.nodes as Record<string, unknown>)[old.id];
      const moved = exposure("src/routes/teams.ts", 44, 4, "POST", "/teams/:teamId/invitations", { boundTo: "Action:Team.inviteMember", middleware: ["auth()"] });
      g.nodes[moved.id] = moved;
      (g.nodes["Action:Team.inviteMember"] as ActionNode).route!.exposure = moved.id as `Exposure:${string}`;
      g.edges = g.edges.map((e) => ({ ...e, from: e.from === old.id ? moved.id : e.from, to: e.to === old.id ? moved.id : e.to }));
    });
    const d = diffGraphs(exampleGraph(), h);
    expect(ops(d, "rename")).toEqual([{ op: "rename", node: "Exposure:hono:src/routes/teams.ts:44:4", target: "Exposure:hono:src/routes/teams.ts:41:4" }]);
    expect(ops(d, "change").map((o) => o.target)).toEqual(["route.exposure"]);
    expect(ops(d, "add-edge")).toEqual([]);
    expect(ops(d, "remove-edge")).toEqual([]);
    expect(opsTouching(d, ["Exposure:hono:src/routes/teams.ts:41:4"])).toHaveLength(1);
  });
});

describe("diffValues", () => {
  it("recurses into objects, treats arrays as leaves, skips top-level keys", () => {
    expect(diffValues({ a: { b: 1, c: [1] }, d: 1, e: 2 }, { a: { b: 2, c: [1, 2] }, d: 1 }, new Set(["e"]))).toEqual([
      { target: "a.b", before: 1, after: 2 },
      { target: "a.c", before: [1], after: [1, 2] },
    ]);
    expect(diffValues({ a: null }, { a: { b: 1 } })).toEqual([{ target: "a", before: null, after: { b: 1 } }]);
    expect(diffValues(1, 2)).toEqual([{ target: "", before: 1, after: 2 }]);
    expect(diffValues({ a: undefined }, {})).toEqual([]);
  });
});

describe("diffGraphs — properties", () => {
  const nodeArb = fc.oneof(
    fc.stringMatching(/^[A-Z][a-z]{1,4}$/).map((n) => event(n)),
    fc.tuple(fc.stringMatching(/^[A-Z][a-z]{1,4}$/), fc.stringMatching(/^[a-z]{1,5}$/)).map(([s, v]) => action(`${s}.${v}`, { handler: { file: `src/${s}.ts`, symbol: `${v}.run` } })),
  );
  const edgeArb = (nodes: Node[]): fc.Arbitrary<Edge[]> => {
    const actions = nodes.filter((n) => n.kind === "Action");
    const events = nodes.filter((n) => n.kind === "Event");
    if (actions.length === 0 || events.length === 0) return fc.constant([]);
    return fc.array(fc.tuple(fc.constantFrom(...actions), fc.constantFrom(...events)).map(([a, e]) => edge("emits", a.id, e.id)), { maxLength: 6 });
  };
  const graphArb = fc.uniqueArray(nodeArb, { maxLength: 8, selector: (n) => n.id }).chain((nodes) => edgeArb(nodes).map((edges) => graph(nodes, edges)));

  it("diff(g, g) is empty; diff is deterministic under node/edge order; add/remove are inverses", () => {
    fc.assert(
      fc.property(graphArb, graphArb, (a, b) => {
        expect(diffGraphs(a, a).ops).toEqual([]);
        const ab = diffGraphs(a, b);
        const shuffledB: Graph = { ...b, nodes: Object.fromEntries(Object.entries(b.nodes).reverse()) as Graph["nodes"], edges: b.edges.slice().reverse() };
        expect(diffGraphs(a, shuffledB)).toEqual(ab);
        const ba = diffGraphs(b, a);
        const inverse: Record<string, string> = { add: "remove", remove: "add", "add-edge": "remove-edge", "remove-edge": "add-edge" };
        const invert = (o: GraphDiffOp): GraphDiffOp => ({ ...o, op: (inverse[o.op] ?? o.op) as GraphDiffOp["op"], ...(o.op === "rename" ? { node: o.target as GraphDiffOp["node"], target: o.node } : {}) });
        const norm = (list: GraphDiffOp[]): string[] => list.map((o) => JSON.stringify({ op: o.op, node: o.node, target: o.target })).sort();
        expect(norm(ba.ops)).toEqual(norm(ab.ops.map(invert)));
        expect(GraphDiffSchema.safeParse(ab).success).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
  it("every node on one side only yields exactly one add/remove (unless renamed)", () => {
    fc.assert(
      fc.property(graphArb, graphArb, (a, b) => {
        const d = diffGraphs(a, b);
        const renamedOld = new Set<string>(d.ops.filter((o) => o.op === "rename").map((o) => o.target as string));
        const renamedNew = new Set<string>(d.ops.filter((o) => o.op === "rename").map((o) => o.node));
        const removed = Object.keys(a.nodes).filter((id) => !(id in b.nodes) && !renamedOld.has(id));
        const added = Object.keys(b.nodes).filter((id) => !(id in a.nodes) && !renamedNew.has(id));
        expect(d.ops.filter((o) => o.op === "remove").map((o) => o.node).sort()).toEqual(removed.sort());
        expect(d.ops.filter((o) => o.op === "add").map((o) => o.node).sort()).toEqual(added.sort());
      }),
      { numRuns: 100 },
    );
  });
});

describe("summary helper on test nodes", () => {
  it("labels exposures as routes and pluralises", () => {
    const base = graph([]);
    const h = graph([exposure("src/a.ts", 1, 0, "GET", "/a"), exposure("src/a.ts", 2, 0, "GET", "/b"), test("Test:tests/x.test.ts:1", [])]);
    expect(summarizeGraphDiff(diffGraphs(base, h))).toBe("+2 routes, +1 test");
  });
});
