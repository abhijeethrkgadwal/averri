/**
 * Tier-1 evaluator (SPEC-CONTRACTS §4): comparison normalisation, fail-closed undefined refs, AST-path
 * keyed `evaluated`, owned-list ops, `emitted`, and the sync/async boundary for db ops.
 */
import { describe, expect, it } from "vitest";
import { db, e } from "@averri/core";
import { AverriRuntimeError, evaluateClause, evaluateExpr, evaluateOperand } from "../src/index.js";
import { MemberInvited } from "./helpers/fixtures.js";

const ast = (clause: { ast: unknown }) => clause.ast as never;

describe("comparisons", () => {
  it("eq/ne on strings, numbers, booleans and null", () => {
    expect(evaluateExpr(ast(e.eq("input.status", "pending")), { input: { status: "pending" } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq("input.n", 3)), { input: { n: 3 } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq("input.n", 3)), { input: { n: "3" } }).ok).toBe(false);
    expect(evaluateExpr(ast(e.eq("input.flag", true)), { input: { flag: true } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq("input.x", null)), { input: { x: null } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq("input.x", null)), { input: { x: 0 } }).ok).toBe(false);
    expect(evaluateExpr(ast(e.ne("input.x", "a")), { input: { x: "b" } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.ne("input.x", "a")), { input: { x: null } }).ok).toBe(true);
  });

  it("normalises Date, BigInt and Decimal-like values", () => {
    const d = new Date("2026-10-24T00:00:00.000Z");
    expect(evaluateExpr(ast(e.eq("self.at", e.input("at"))), { self: { at: d }, input: { at: new Date(d.getTime()) } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq("self.at", d.getTime())), { self: { at: d } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq("self.big", 10)), { self: { big: 10n } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq("self.amount", 1.5)), { self: { amount: { toNumber: () => 1.5, toString: () => "1.5" } } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.lt("self.at", e.input("later"))), { self: { at: d }, input: { later: new Date(d.getTime() + 1) } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq("self.at", "x")), { self: { at: new Date("invalid") } }).ok).toBe(false);
  });

  it("lt/lte/gt/gte require numeric (or date) operands; strings are false", () => {
    expect(evaluateExpr(ast(e.lt("input.n", 5)), { input: { n: 4 } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.lte("input.n", 5)), { input: { n: 5 } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.gt("input.n", 5)), { input: { n: 5 } }).ok).toBe(false);
    expect(evaluateExpr(ast(e.gte("input.n", 5)), { input: { n: 5 } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.lt("input.s", "b")), { input: { s: "a" } }).ok).toBe(false);
    expect(evaluateExpr(ast(e.gt("input.n", 1)), { input: { n: Number.NaN } }).ok).toBe(false);
  });

  it("fails closed on undefined refs and lists them", () => {
    const r = evaluateExpr(ast(e.eq("input.missing", "x")), { input: {} });
    expect(r.ok).toBe(false);
    expect(r.undefinedRefs).toEqual(["input.missing"]);
    expect(evaluateExpr(ast(e.ne("input.missing", "x")), { input: {} }).ok).toBe(false);
    expect(evaluateExpr(ast(e.eq("self.x", 1)), { self: null }).undefinedRefs).toEqual(["self.x"]);
    expect(evaluateExpr(ast(e.eq("actor.orgId", "o1")), {}).undefinedRefs).toEqual(["actor.orgId"]);
    // deep path through a non-object
    expect(evaluateExpr(ast(e.eq("input.a.b.c", 1)), { input: { a: "str" } }).undefinedRefs).toEqual(["input.a.b.c"]);
    // two undefined refs on both sides, deduplicated
    const both = evaluateExpr(ast(e.and(e.eq("input.a", e.input("b")), e.eq("input.a", 1))), { input: {} });
    expect(both.undefinedRefs).toEqual(["input.a", "input.b"]);
  });

  it("records evaluated values keyed by AST path with JSON-safe values", () => {
    const d = new Date("2026-10-24T00:00:00.000Z");
    const r = evaluateExpr(ast(e.eq("self.at", e.input("at"))), { self: { at: d }, input: { at: 5n } });
    expect(r.evaluated).toEqual({ "": { lhs: "2026-10-24T00:00:00.000Z", rhs: "5" } });
    const missing = evaluateExpr(ast(e.eq("input.x", 1)), { input: {} });
    expect(missing.evaluated).toEqual({ "": { lhs: null, rhs: 1 } });
  });
});

describe("boolean connectives", () => {
  it("and: short-circuits and keeps only the first failing conjunct's leaves", () => {
    const clause = ast(e.and(e.eq("input.a", 1), e.eq("input.b", 2), e.eq("input.c", 3)));
    const fail = evaluateExpr(clause, { input: { a: 1, b: 9, c: 3 } });
    expect(fail.ok).toBe(false);
    expect(Object.keys(fail.evaluated)).toEqual(["args[1]"]);
    expect(fail.evaluated["args[1]"]).toEqual({ lhs: 9, rhs: 2 });
    const pass = evaluateExpr(clause, { input: { a: 1, b: 2, c: 3 } });
    expect(pass.ok).toBe(true);
    expect(Object.keys(pass.evaluated)).toEqual(["args[0]", "args[1]", "args[2]"]);
  });

  it("or: evaluates every leaf when failing, short-circuits when passing", () => {
    const clause = ast(e.or(e.eq("input.a", 1), e.eq("input.b", 2)));
    const fail = evaluateExpr(clause, { input: { a: 0, b: 0 } });
    expect(fail.ok).toBe(false);
    expect(Object.keys(fail.evaluated)).toEqual(["args[0]", "args[1]"]);
    const pass = evaluateExpr(clause, { input: { a: 1, b: 0 } });
    expect(pass.ok).toBe(true);
    expect(Object.keys(pass.evaluated)).toEqual(["args[0]"]);
  });

  it("not flips and nests the path under `arg`", () => {
    const r = evaluateExpr(ast(e.not(e.and(e.eq("input.a", 1)))), { input: { a: 1 } });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.evaluated)).toEqual(["arg.args[0]"]);
    expect(evaluateExpr(ast(e.not(e.eq("input.a", 1))), { input: { a: 2 } }).ok).toBe(true);
    // fail closed under negation: an undefined ref inside `not` poisons the clause (D-41a); it never flips to a pass
    const u = evaluateExpr(ast(e.not(e.eq("input.a", 1))), { input: {} });
    expect(u.ok).toBe(false);
    expect(u.undefinedRefs).toEqual(["input.a"]);
    // isNull stays meaningful under not: a missing field is null
    expect(evaluateExpr(ast(e.not(e.isNull("self.x"))), { self: {} }).ok).toBe(false);
    expect(evaluateExpr(ast(e.not(e.isNull("self.x"))), { self: { x: 1 } }).ok).toBe(true);
    // the poison is scoped to the negation: an undefined ref outside `not` keeps the plain false-comparison rule
    expect(evaluateExpr(ast(e.or(e.eq("input.zz", 1), e.not(e.eq("input.a", 1)))), { input: { a: 2 } }).ok).toBe(true);
  });
});

describe("in, isNull, len, sum, count, exists, emitted", () => {
  it("in over a literal list and a list-valued ref", () => {
    expect(evaluateExpr(ast(e.in("input.role", ["admin", "owner"])), { input: { role: "admin" } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.in("input.role", ["admin", "owner"])), { input: { role: "member" } }).ok).toBe(false);
    expect(evaluateExpr(ast(e.in("input.role", e.actor("roles"))), { input: { role: "x" }, actor: { roles: ["x", "y"] } }).ok).toBe(true);
    const r = evaluateExpr(ast(e.in("input.role", e.actor("roles"))), { input: { role: "x" }, actor: { roles: "x" } });
    expect(r.ok).toBe(false);
    expect(evaluateExpr(ast(e.in("input.n", [1, 2])), { input: { n: 2n } }).ok).toBe(true);
  });

  it("isNull is true for null and undefined and does not list the ref as undefined", () => {
    expect(evaluateExpr(ast(e.isNull("acceptedAt")), { self: { acceptedAt: null } }).ok).toBe(true);
    const r = evaluateExpr(ast(e.isNull("acceptedAt")), { self: {} });
    expect(r.ok).toBe(true);
    expect(r.undefinedRefs).toEqual([]);
    expect(evaluateExpr(ast(e.isNull("acceptedAt")), { self: { acceptedAt: new Date() } }).ok).toBe(false);
  });

  it("len over strings and lists", () => {
    expect(evaluateExpr(ast(e.lte(e.len("input.name"), 3)), { input: { name: "abc" } }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq(e.len("self.lines"), 2)), { self: { lines: [1, 2] } }).ok).toBe(true);
    const r = evaluateExpr(ast(e.eq(e.len("self.n"), 2)), { self: { n: 2 } });
    expect(r.ok).toBe(false);
  });

  it("sum, count and exists over owned lists with element-scoped where", () => {
    const self = { lines: [{ amount: 2, kind: "a" }, { amount: 3, kind: "b" }, { amount: 5n, kind: "a" }] };
    expect(evaluateExpr(ast(e.eq(e.sum("self.lines", "amount"), 10)), { self }).ok).toBe(true);
    expect(evaluateOperand(ast(e.sum("self.lines", "amount")), { self }).value).toBe(10);
    expect(evaluateOperand(ast(e.sum("self.lines", "kind")), { self }).value).toBeUndefined();
    expect(evaluateExpr(ast(e.eq(e.count("self.lines"), 3)), { self }).ok).toBe(true);
    expect(evaluateExpr(ast(e.eq(e.count("self.lines", e.eq("kind", "a")), 2)), { self }).ok).toBe(true);
    expect(evaluateExpr(ast(e.exists("self.lines", e.eq("amount", 3))), { self }).ok).toBe(true);
    expect(evaluateExpr(ast(e.exists("self.lines", e.eq("amount", 99))), { self }).ok).toBe(false);
    expect(evaluateExpr(ast(e.exists("self.lines")), { self: { lines: [] } }).ok).toBe(false);
    const notList = evaluateExpr(ast(e.exists("self.lines")), { self: {} });
    expect(notList.ok).toBe(false);
    expect(notList.undefinedRefs).toEqual(["self.lines"]);
    // element filter leaves are not recorded; the exists node is
    const r = evaluateExpr(ast(e.exists("self.lines", e.eq("kind", "a"))), { self });
    expect(r.evaluated).toEqual({ "": { lhs: 2, rhs: "count >= 1" } });
    // inside the element filter, `input` still refers to the action input
    expect(evaluateExpr(ast(e.exists("self.lines", e.eq("kind", e.input("k")))), { self, input: { k: "b" } }).ok).toBe(true);
  });

  it("emitted counts buffered emissions: exact, min/max, default at-least-once", () => {
    const id = MemberInvited.id;
    expect(evaluateExpr(ast(e.emitted(MemberInvited)), { emitted: [id] }).ok).toBe(true);
    expect(evaluateExpr(ast(e.emitted(MemberInvited)), { emitted: [] }).ok).toBe(false);
    expect(evaluateExpr(ast(e.emitted(MemberInvited, 1)), { emitted: [id, id] }).ok).toBe(false);
    expect(evaluateExpr(ast(e.emitted(MemberInvited, 0)), { emitted: [] }).ok).toBe(true);
    expect(evaluateExpr(ast(e.emitted(MemberInvited, { min: 1, max: 2 })), { emitted: [id, id] }).ok).toBe(true);
    expect(evaluateExpr(ast(e.emitted(MemberInvited, { max: 1 })), { emitted: [id, id] }).ok).toBe(false);
    const r = evaluateExpr(ast(e.emitted(MemberInvited, 1)), { emitted: [] });
    expect(r.evaluated).toEqual({ "": { lhs: 0, rhs: 1 } });
  });
});

describe("db ops at the sync boundary", () => {
  it("evaluateExpr throws db-op-in-sync-eval for predicates without pre-fetched results", () => {
    let caught: unknown;
    try {
      evaluateExpr(ast(db.exists("membership", { teamId: e.input("teamId") })), { input: { teamId: "t1" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AverriRuntimeError);
    expect((caught as AverriRuntimeError).code).toBe("db-op-in-sync-eval");
  });

  it("evaluateClause without a client reports the predicate as a failed, fail-closed clause", async () => {
    const r = await evaluateClause(ast(db.exists("membership", { teamId: e.input("teamId") })), { input: { teamId: "t1" } }, null);
    expect(r.ok).toBe(false);
    expect(r.dbCalls).toBe(0);
    expect(r.errors[0]).toMatch(/needs a Prisma client/);
  });

  it("evaluateClause on a pure expression performs no db work", async () => {
    const r = await evaluateClause(ast(e.eq("input.a", 1)), { input: { a: 1 } });
    expect(r).toEqual({ ok: true, evaluated: { "": { lhs: 1, rhs: 1 } }, undefinedRefs: [], dbCalls: 0, errors: [] });
  });
});
