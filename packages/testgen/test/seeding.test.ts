/**
 * Fixture seeding against a real app's domain (D-40): `or` policies seeded per disjunct with actor
 * guards, column domains from entity invariants and Prisma enums, Field names from ids, and the
 * precondition-violation rules for mixed clauses and subject-covering predicates.
 */
import { describe, expect, it } from "vitest";
import type { BoolExpr, ContractNode, EntityNode, FieldNode, Graph } from "@averri/ir";
import { generateTests } from "../src/generate.js";
import { withColumnDomain } from "../src/fixtures.js";
import { SchemaFacts } from "../src/schema.js";
import { contract, field, referenceGraph } from "./fixture-graph.js";

const isUser: BoolExpr = { op: "eq", lhs: { ref: "actor.type" }, rhs: { lit: "user" } };
const isKey: BoolExpr = { op: "eq", lhs: { ref: "actor.type" }, rhs: { lit: "apiKey" } };

function withPolicy(expr: BoolExpr): Graph {
  const g = referenceGraph();
  const nodes = { ...g.nodes } as Record<string, unknown>;
  const c = nodes["Contract:Team.OwnerOrAdmin.allow"] as ContractNode;
  nodes["Contract:Team.OwnerOrAdmin.allow"] = { ...c, expr };
  return { ...g, nodes: nodes as Graph["nodes"] };
}

function fileOf(graph: Graph, path: string): string {
  const f = generateTests(graph, { actors: ["anonymous", "member", "admin"] }).find((x) => x.path === path);
  if (!f) throw new Error(`no ${path}`);
  return f.content;
}

describe("policy seeding", () => {
  it("seeds an `or` policy one disjunct at a time, skipping disjuncts whose actor guard fails", () => {
    const graph = withPolicy({
      op: "or",
      args: [
        { op: "and", args: [isUser, { op: "db.exists", model: "membership", where: { teamId: { ref: "input.teamId" }, userId: { ref: "actor.id" } } }] },
        { op: "and", args: [isKey, { op: "db.exists", model: "membership", where: { teamId: { ref: "input.teamId" }, role: { lit: "admin" } } }] },
      ],
    });
    const content = fileOf(graph, "tests/averri/Team.inviteMember.gen.test.ts");
    const fn = content.slice(content.indexOf("async function seedPolicy_Team_inviteMember("), content.indexOf("\n}\n", content.indexOf("async function seedPolicy_Team_inviteMember(")));
    expect(fn).toContain('if (mode === "falsify") {');
    expect(fn).toContain('if (env.actor?.["type"] === "user") {');
    expect(fn).toContain('if (env.actor?.["type"] === "apiKey") {');
    expect(fn).toContain('if (["allow", "public", "opaque"].includes(await h.policyDecision("Action:Team.inviteMember", fixture, env.input))) return;');
    expect(content).toContain('await seedPolicy_Team_inviteMember(h, env, "satisfy", fixture);');
  });

  it("keeps the single-disjunct shape for an `and` policy", () => {
    const content = fileOf(referenceGraph(), "tests/averri/Team.inviteMember.gen.test.ts");
    const start = content.indexOf("async function seedPolicy_Team_inviteMember(");
    const fn = content.slice(start, content.indexOf("\n}\n", start));
    expect(fn).not.toContain("falsify");
    expect(fn).toContain("(h, env, mode);");
  });
});

describe("column domains", () => {
  it("SchemaFacts strips the model prefix from Field names and reads single-comparison invariants", () => {
    const g = referenceGraph();
    const nodes = { ...g.nodes } as Record<string, unknown>;
    const qualified = field("Membership", "joinedAt");
    nodes[qualified.id] = { ...qualified, name: "Membership.joinedAt" } satisfies FieldNode;
    const team = nodes["Entity:Team"] as EntityNode;
    nodes["Entity:Team"] = { ...team, invariants: ["Contract:Team.invariant.statusKnown", "Contract:Team.invariant.cond"] };
    nodes["Contract:Team.invariant.statusKnown"] = contract("Contract:Team.invariant.statusKnown", "Entity:Team", "invariant", { op: "in", lhs: { ref: "self.status" }, rhs: { lit: ["active", "suspended"] } });
    nodes["Contract:Team.invariant.cond"] = contract("Contract:Team.invariant.cond", "Entity:Team", "invariant", { op: "or", args: [{ op: "ne", lhs: { ref: "self.status" }, rhs: { lit: "x" } }, { op: "isNull", arg: { ref: "self.name" } }] });
    const facts = new SchemaFacts({ nodes: nodes as Graph["nodes"] });
    expect(facts.field("Entity:Membership", "joinedAt")?.name).toBe("joinedAt");
    expect(facts.columnConstraint("Entity:Team", "status")).toMatchObject({ in: ["active", "suspended"] });
    expect(facts.columnConstraint("Entity:Team", "name")).toBeNull();
  });

  it("withColumnDomain narrows a violating constraint to the column's other values", () => {
    const c = { root: "self" as const, field: "status", ne: ["active"], notIn: [] };
    expect(withColumnDomain(c, { root: "self", field: "status", ne: [], notIn: [], in: ["active", "archived"] })).toEqual({ ...c, ne: [], in: ["archived"] });
    expect(withColumnDomain(c, null)).toBe(c);
    expect(withColumnDomain({ ...c, ne: ["active", "archived"] }, { root: "self", field: "status", ne: [], notIn: [], in: ["active", "archived"] })).toEqual({ ...c, ne: ["active", "archived"] });
  });
});

describe("precondition violations", () => {
  it("a requires clause mixing predicates with other conditions under `or` gets a todo, not a wrong test", () => {
    const g = referenceGraph();
    const nodes = { ...g.nodes } as Record<string, unknown>;
    const c = nodes["Contract:Team.inviteMember.requires.notAlreadyMember"] as ContractNode;
    nodes[c.id] = { ...c, expr: { op: "or", args: [{ op: "eq", lhs: { ref: "input.role" }, rhs: { lit: "admin" } }, c.expr as BoolExpr] } };
    const content = fileOf({ ...g, nodes: nodes as Graph["nodes"] }, "tests/averri/Team.inviteMember.gen.test.ts");
    expect(content).toContain("[Contract:Team.inviteMember.requires.notAlreadyMember] violation is rejected: the clause combines db predicates with other conditions under or/not");
  });
});
