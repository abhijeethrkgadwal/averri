import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { classifyContractChange, compareClauses, compareWhere, type BoolExpr } from "../src/index.js";
import { boolExprArb } from "./arbitraries.js";

const eq = (ref: string, lit: unknown): BoolExpr => ({ op: "eq", lhs: { ref: ref as never }, rhs: { lit: lit as never } });
const cmp = (op: "lt" | "lte" | "gt" | "gte", n: number): BoolExpr => ({ op, lhs: { ref: "input.n" }, rhs: { lit: n } });
const inList = (list: unknown[]): BoolExpr => ({ op: "in", lhs: { ref: "input.role" }, rhs: { lit: list as never } });
const A = eq("input.a", 1);
const B = eq("input.b", 2);
const C = eq("input.c", 3);

describe("compareClauses — SPEC-CONTRACTS §7 table", () => {
  it("equal / structurally different ops", () => {
    expect(compareClauses(A, { rhs: { lit: 1 }, lhs: { ref: "input.a" }, op: "eq" })).toBe("equal");
    expect(compareClauses(A, { op: "isNull", arg: { ref: "input.a" } })).toBe("undecided");
    expect(compareClauses(A, B)).toBe("undecided"); // eq constant/ref change
  });
  it("and: drop a conjunct admits more, add admits fewer, one edited conjunct recurses", () => {
    expect(compareClauses({ op: "and", args: [A, B] }, { op: "and", args: [A] })).toBe("admits-more");
    expect(compareClauses({ op: "and", args: [A] }, { op: "and", args: [A, B] })).toBe("admits-fewer");
    expect(compareClauses({ op: "and", args: [B, A] }, { op: "and", args: [A, B] })).toBe("equal");
    expect(compareClauses({ op: "and", args: [A, cmp("lt", 5)] }, { op: "and", args: [A, cmp("lt", 9)] })).toBe("admits-more");
    expect(compareClauses({ op: "and", args: [A, B] }, { op: "and", args: [A, C] })).toBe("undecided");
    expect(compareClauses({ op: "and", args: [A, B, C] }, { op: "and", args: [A] })).toBe("admits-more");
    expect(compareClauses({ op: "and", args: [A, B] }, { op: "and", args: [C, cmp("lt", 1)] })).toBe("undecided");
  });
  it("or: add a disjunct admits more, drop admits fewer", () => {
    expect(compareClauses({ op: "or", args: [A] }, { op: "or", args: [A, B] })).toBe("admits-more");
    expect(compareClauses({ op: "or", args: [A, B] }, { op: "or", args: [A] })).toBe("admits-fewer");
    expect(compareClauses({ op: "or", args: [A, cmp("lt", 5)] }, { op: "or", args: [A, cmp("lt", 2)] })).toBe("admits-fewer");
  });
  it("not flips polarity", () => {
    expect(compareClauses({ op: "not", arg: { op: "and", args: [A, B] } }, { op: "not", arg: { op: "and", args: [A] } })).toBe("admits-fewer");
    expect(compareClauses({ op: "not", arg: cmp("lt", 5) }, { op: "not", arg: cmp("lt", 9) })).toBe("admits-fewer");
    expect(compareClauses({ op: "not", arg: { op: "not", arg: cmp("lt", 5) } }, { op: "not", arg: { op: "not", arg: cmp("lt", 9) } })).toBe("admits-more");
  });
  it("comparisons with numeric literals", () => {
    expect(compareClauses(cmp("lt", 5), cmp("lt", 9))).toBe("admits-more");
    expect(compareClauses(cmp("lt", 9), cmp("lt", 5))).toBe("admits-fewer");
    expect(compareClauses(cmp("lte", 5), cmp("lte", 9))).toBe("admits-more");
    expect(compareClauses(cmp("gt", 5), cmp("gt", 2))).toBe("admits-more");
    expect(compareClauses(cmp("gte", 5), cmp("gte", 7))).toBe("admits-fewer");
    expect(compareClauses(cmp("lt", 5), cmp("lte", 5))).toBe("admits-more");
    expect(compareClauses(cmp("lte", 5), cmp("lt", 5))).toBe("admits-fewer");
    expect(compareClauses(cmp("gt", 5), cmp("gte", 5))).toBe("admits-more");
    expect(compareClauses(cmp("gte", 5), cmp("gt", 5))).toBe("admits-fewer");
    expect(compareClauses(cmp("lt", 5), cmp("gt", 5))).toBe("undecided");
    expect(compareClauses(cmp("lt", 5), { op: "lt", lhs: { ref: "input.m" }, rhs: { lit: 9 } })).toBe("undecided");
    expect(compareClauses(cmp("lt", 5), { op: "lt", lhs: { ref: "input.n" }, rhs: { ref: "input.max" } })).toBe("undecided");
    expect(compareClauses(eq("input.a", 1), eq("input.a", 2))).toBe("undecided");
    expect(compareClauses({ op: "ne", lhs: { ref: "input.a" }, rhs: { lit: 1 } }, { op: "ne", lhs: { ref: "input.a" }, rhs: { lit: 2 } })).toBe("undecided");
    const count: BoolExpr = { op: "lt", lhs: { op: "db.countWhere", model: "m", where: {} }, rhs: { lit: 1 } };
    expect(compareClauses(count, { ...count, rhs: { lit: 2 } })).toBe("undecided");
  });
  it("in: list grows / shrinks", () => {
    expect(compareClauses(inList(["a"]), inList(["a", "b"]))).toBe("admits-more");
    expect(compareClauses(inList(["a", "b"]), inList(["b"]))).toBe("admits-fewer");
    expect(compareClauses(inList(["a", "b"]), inList(["b", "a", "a"]))).toBe("equal");
    expect(compareClauses(inList(["a"]), inList(["b"]))).toBe("undecided");
    expect(compareClauses(inList(["a"]), { op: "in", lhs: { ref: "input.role" }, rhs: { ref: "self.roles" } })).toBe("undecided");
    expect(compareClauses(inList(["a"]), { op: "in", lhs: { ref: "input.other" }, rhs: { lit: ["a", "b"] } })).toBe("undecided");
  });
  it("emitted: count range widens / narrows", () => {
    const em = (count?: number | { min?: number; max?: number }): BoolExpr => (count === undefined ? { op: "emitted", event: "Event:X" } : { op: "emitted", event: "Event:X", count });
    expect(compareClauses(em(1), em({ min: 1 }))).toBe("admits-more");
    expect(compareClauses(em(), em(1))).toBe("admits-fewer");
    expect(compareClauses(em({ min: 1, max: 3 }), em({ min: 0, max: 5 }))).toBe("admits-more");
    expect(compareClauses(em({ min: 1, max: 3 }), em({ min: 2, max: 3 }))).toBe("admits-fewer");
    expect(compareClauses(em({ min: 1, max: 3 }), em({ min: 2, max: 5 }))).toBe("undecided");
    expect(compareClauses(em(1), { op: "emitted", event: "Event:Y", count: 1 })).toBe("undecided");
  });
  it("db.exists / db.unique: looser where admits more; db.none reversed", () => {
    const ex = (where: BoolExpr extends never ? never : Record<string, unknown>): BoolExpr => ({ op: "db.exists", model: "m", where: where as never });
    expect(compareClauses(ex({ a: { ref: "input.a" }, b: { lit: 1 } }), ex({ a: { ref: "input.a" } }))).toBe("admits-more");
    expect(compareClauses(ex({ a: { ref: "input.a" } }), ex({ a: { ref: "input.a" }, b: { lit: 1 } }))).toBe("admits-fewer");
    expect(compareClauses(ex({ r: { in: { lit: ["a"] } } }), ex({ r: { in: { lit: ["a", "b"] } } }))).toBe("admits-more");
    expect(compareClauses(ex({ n: { lt: { lit: 5 } } }), ex({ n: { lt: { lit: 9 } } }))).toBe("admits-more");
    expect(compareClauses(ex({ n: { gt: { lit: 5 } } }), ex({ n: { gt: { lit: 9 } } }))).toBe("admits-fewer");
    expect(compareClauses(ex({ a: { lit: 1 } }), ex({ a: { lit: 2 } }))).toBe("undecided");
    expect(compareClauses(ex({ a: { lit: 1 } }), { op: "db.exists", model: "other", where: { a: { lit: 1 } } })).toBe("undecided");
    expect(compareClauses({ op: "db.unique", model: "m", where: { a: { lit: 1 }, b: { lit: 1 } } }, { op: "db.unique", model: "m", where: { a: { lit: 1 } } })).toBe("admits-more");
    expect(compareClauses({ op: "db.none", model: "m", where: { a: { lit: 1 }, b: { lit: 1 } } }, { op: "db.none", model: "m", where: { a: { lit: 1 } } })).toBe("admits-fewer");
    expect(compareClauses({ op: "db.none", model: "m", where: { a: { lit: 1 } } }, { op: "db.none", model: "m", where: { a: { lit: 1 }, b: { lit: 1 } } })).toBe("admits-more");
    // mixed directions are undecided
    expect(compareClauses(ex({ a: { lit: 1 }, b: { lit: 1 } }), ex({ a: { lit: 1 }, c: { lit: 1 } }))).toBe("undecided");
  });
  it("isNull / exists edits are undecided", () => {
    expect(compareClauses({ op: "isNull", arg: { ref: "input.a" } }, { op: "isNull", arg: { ref: "input.b" } })).toBe("undecided");
    expect(compareClauses({ op: "exists", path: { ref: "self.l" } }, { op: "exists", path: { ref: "self.l" }, where: A })).toBe("undecided");
  });
  it("property: compareClauses is reflexive-equal and antisymmetric", () => {
    fc.assert(
      fc.property(boolExprArb(), boolExprArb(), (a, b) => {
        expect(compareClauses(a, a)).toBe("equal");
        const ab = compareClauses(a, b);
        const ba = compareClauses(b, a);
        const flip = { equal: "equal", undecided: "undecided", "admits-more": "admits-fewer", "admits-fewer": "admits-more" } as const;
        expect(ba).toBe(flip[ab]);
      }),
      { numRuns: 300 },
    );
  });
  it("property: dropping a conjunct from a random and-clause admits more", () => {
    fc.assert(
      fc.property(fc.array(boolExprArb(), { minLength: 2, maxLength: 4 }), (args) => {
        const before: BoolExpr = { op: "and", args };
        const after: BoolExpr = { op: "and", args: args.slice(1) };
        const rel = compareClauses(before, after);
        // equal only when the dropped conjunct duplicates a remaining one
        expect(["admits-more", "equal"]).toContain(rel);
        expect(compareClauses({ op: "not", arg: before }, { op: "not", arg: after })).toBe(rel === "equal" ? "equal" : "admits-fewer");
      }),
      { numRuns: 200 },
    );
  });
});

describe("compareWhere", () => {
  it("relations", () => {
    expect(compareWhere({ a: { lit: 1 } }, { a: { lit: 1 } })).toBe("equal");
    expect(compareWhere({ a: { lit: 1 }, b: { lit: 2 } }, { a: { lit: 1 } })).toBe("looser");
    expect(compareWhere({ a: { lit: 1 } }, { a: { lit: 1 }, b: { lit: 2 } })).toBe("tighter");
    expect(compareWhere({ a: { in: { lit: [1] } } }, { a: { in: { lit: [1, 2] } } })).toBe("looser");
    expect(compareWhere({ a: { in: { ref: "input.x" } } }, { a: { in: { lit: [1, 2] } } })).toBe("undecided");
    expect(compareWhere({ a: { lte: { lit: 1 } } }, { a: { lte: { lit: 0 } } })).toBe("tighter");
    expect(compareWhere({ a: { gte: { lit: 1 } } }, { a: { gte: { lit: 0 } } })).toBe("looser");
    expect(compareWhere({ a: { lt: { ref: "input.x" } } }, { a: { lt: { lit: 0 } } })).toBe("undecided");
    expect(compareWhere({ a: { not: { lit: 1 } } }, { a: { not: { lit: 2 } } })).toBe("undecided");
    expect(compareWhere({ a: { lit: 1 } }, { a: { ref: "input.a" } })).toBe("undecided");
  });
});

describe("classifyContractChange", () => {
  it("maps relations and tier transitions to ops", () => {
    expect(classifyContractChange({ tier: "expr", expr: cmp("lt", 5) }, { tier: "expr", expr: cmp("lt", 9) })).toBe("weaken-contract");
    expect(classifyContractChange({ tier: "expr", expr: cmp("lt", 9) }, { tier: "expr", expr: cmp("lt", 5) })).toBe("strengthen-contract");
    expect(classifyContractChange({ tier: "expr", expr: A }, { tier: "expr", expr: B })).toBe("change");
    expect(classifyContractChange({ tier: "expr", expr: A }, { tier: "expr", expr: A })).toBe("equal");
    expect(classifyContractChange({ tier: "expr", expr: A }, { tier: "guard", expr: null })).toBe("weaken-contract");
    expect(classifyContractChange({ tier: "predicate", expr: A }, { tier: "guard", expr: null })).toBe("weaken-contract");
    expect(classifyContractChange({ tier: "guard", expr: null }, { tier: "expr", expr: A })).toBe("change");
    expect(classifyContractChange({ tier: "guard", expr: null }, { tier: "guard", expr: null })).toBe("equal");
    expect(classifyContractChange({ tier: "expr", expr: null }, { tier: "expr", expr: A })).toBe("change");
  });
});
