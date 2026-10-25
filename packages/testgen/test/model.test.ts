import type { ActionNode, BoolExpr, ContractId, ContractNode } from "@averri/ir";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildActionModel, inputArbitrary, satisfyAll, violateOne, type Ctx } from "../src/model.js";
import { resolveOptions } from "../src/generate.js";
import { SchemaFacts } from "../src/schema.js";
import { referenceGraph } from "./fixture-graph.js";
import { evalClause, instantiate } from "./mini-eval.js";

function ctxOf() {
  const graph = referenceGraph();
  const ctx: Ctx = { graph, facts: new SchemaFacts(graph), options: resolveOptions(graph, {}) };
  return ctx;
}

describe("buildActionModel", () => {
  it("classifies contracts and resolves policy, subject and writes", () => {
    const ctx = ctxOf();
    const m = buildActionModel(ctx, ctx.graph.nodes["Action:Team.inviteMember"] as ActionNode);
    expect(m.prefix).toBe("Team_inviteMember");
    expect(m.policy?.id).toBe("Policy:Team.OwnerOrAdmin");
    expect(m.requires.map((c) => c.clause)).toEqual(["notAlreadyMember"]);
    expect(m.guards.map((c) => c.clause)).toEqual(["emailDomainAllowed"]);
    expect(m.ensures.map((c) => c.clause)).toEqual(["pendingForEmail"]);
    expect(m.emitted.map((e) => [e.event, e.count])).toEqual([["Event:MemberInvited", 1]]);
    expect(m.writes).toEqual(["invitation"]);
    expect(m.subjectEntity).toBeNull();
  });

  it("infers input types: where keys, literals, entity fields, names", () => {
    const ctx = ctxOf();
    const invite = buildActionModel(ctx, ctx.graph.nodes["Action:Team.inviteMember"] as ActionNode);
    expect(invite.inputFields.map((f) => [f.name, f.type.kind, f.type.unique ?? false])).toEqual([
      ["teamId", "string", false],
      ["email", "string", true],
      ["role", "enum", false],
    ]);
    const rename = buildActionModel(ctx, ctx.graph.nodes["Action:Team.rename"] as ActionNode);
    expect(rename.inputFields.map((f) => [f.name, f.type.kind])).toEqual([
      ["teamId", "string"],
      ["name", "string"],
      ["seats", "int"],
      ["plan", "string"],
    ]);
    expect(rename.inputFields.find((f) => f.name === "teamId")?.type.unique).toBe(true); // subject id
    expect(rename.subjectEntity?.model).toBe("Team");
  });
});

describe("input arbitraries honour the clauses they derive from (property)", () => {
  const ctx = ctxOf();
  const rename = buildActionModel(ctx, ctx.graph.nodes["Action:Team.rename"] as ActionNode);
  const clauses = rename.requires.filter((c) => c.tier === "expr") as Array<ContractNode & { expr: BoolExpr }>;
  const inputOnly = (c: ContractNode & { expr: BoolExpr }) => JSON.stringify(c.expr).includes('"input.') && !JSON.stringify(c.expr).includes('"self.');

  it("the valid input satisfies every tier-1 requires clause over input", () => {
    const all = satisfyAll(rename);
    expect(all.ok).toBe(true);
    const src = inputArbitrary(rename, all.ok ? all.conj : null);
    expect(src.ok).toBe(true);
    const arb = instantiate<Record<string, unknown>>(src.ok ? src.src : "");
    fc.assert(
      fc.property(arb, (input) => {
        for (const c of clauses.filter(inputOnly)) expect(evalClause(c.expr, { input }), c.clause).toBe(true);
      }),
    );
  });

  it("each violating input violates exactly its clause and satisfies the others", () => {
    for (const target of clauses.filter(inputOnly)) {
      const v = violateOne(rename, target);
      expect(v.ok, target.clause).toBe(true);
      const src = inputArbitrary(rename, v.ok ? v.conj : null);
      expect(src.ok, target.clause).toBe(true);
      const arb = instantiate<Record<string, unknown>>(src.ok ? src.src : "");
      fc.assert(
        fc.property(arb, (input) => {
          expect(evalClause(target.expr, { input }), `${target.clause} violated`).toBe(false);
          for (const other of clauses.filter(inputOnly)) {
            if (other.id !== target.id) expect(evalClause(other.expr, { input }), `${other.clause} still satisfied`).toBe(true);
          }
        }),
      );
    }
  });

  it("self.* clauses contribute self constraints, not input constraints", () => {
    const target = clauses.find((c) => c.clause === "teamActive") as ContractNode & { expr: BoolExpr };
    const v = violateOne(rename, target);
    expect(v.ok && v.conj.filter((a) => a.root === "self")).toEqual([{ root: "self", field: "status", op: "ne", value: "active" }]);
  });

  it("reports contradictions and non-derivable clauses", () => {
    const m = buildActionModel(ctx, ctx.graph.nodes["Action:Team.rename"] as ActionNode);
    m.requires.push({ ...(clauses[0] as ContractNode), id: "Contract:Team.rename.requires.seatsHuge" as ContractId, clause: "seatsHuge", expr: { op: "gt", lhs: { ref: "input.seats" }, rhs: { lit: 1000 } } });
    m.analyses.set("Contract:Team.rename.requires.seatsHuge", { ok: true, satisfy: [{ root: "input", field: "seats", op: "gt", value: 1000 }], violate: [{ root: "input", field: "seats", op: "lte", value: 1000 }] });
    const all = satisfyAll(m);
    expect(all.ok).toBe(true);
    expect(inputArbitrary(m, all.ok ? all.conj : null)).toMatchObject({ ok: false, reason: expect.stringContaining("empty numeric range") });
    const unknownField: ContractNode = { ...(clauses[0] as ContractNode), id: "Contract:Team.rename.requires.ghost" as ContractId, clause: "ghost", expr: { op: "eq", lhs: { ref: "input.ghost" }, rhs: { lit: 1 } } };
    const m2 = buildActionModel(ctx, ctx.graph.nodes["Action:Team.rename"] as ActionNode);
    m2.requires.push(unknownField);
    m2.analyses.set(unknownField.id as ContractId, { ok: true, satisfy: [{ root: "input", field: "ghost", op: "eq", value: 1 }], violate: [] });
    expect(violateOne(m2, unknownField)).toMatchObject({ ok: true });
    expect(inputArbitrary(m2, [{ root: "input", field: "ghost", op: "eq", value: 1 }])).toMatchObject({ ok: false, reason: expect.stringContaining("ghost") });
  });
});
