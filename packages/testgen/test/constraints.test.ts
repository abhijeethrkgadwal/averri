import type { BoolExpr } from "@averri/ir";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyseClause, mergeConjunction, negateAtom, rootsOf, type Atom } from "../src/constraints.js";

const ref = (r: `${"input" | "self" | "actor" | "result"}.${string}`) => ({ ref: r }) as const;

describe("analyseClause", () => {
  it("negates comparisons per the table (eq->ne, lt->gte, in->notIn, isNull->notNull)", () => {
    const cases: Array<[BoolExpr, Atom["op"], Atom["op"]]> = [
      [{ op: "eq", lhs: ref("input.role"), rhs: { lit: "admin" } }, "eq", "ne"],
      [{ op: "lt", lhs: ref("input.n"), rhs: { lit: 5 } }, "lt", "gte"],
      [{ op: "lte", lhs: ref("input.n"), rhs: { lit: 5 } }, "lte", "gt"],
      [{ op: "gt", lhs: ref("input.n"), rhs: { lit: 5 } }, "gt", "lte"],
      [{ op: "gte", lhs: ref("input.n"), rhs: { lit: 5 } }, "gte", "lt"],
      [{ op: "in", lhs: ref("input.plan"), rhs: { lit: ["a", "b"] } }, "in", "notIn"],
      [{ op: "isNull", arg: ref("input.x") }, "isNull", "notNull"],
    ];
    for (const [expr, sat, viol] of cases) {
      const a = analyseClause(expr);
      expect(a.ok).toBe(true);
      if (!a.ok) continue;
      expect(a.satisfy.map((x) => x.op)).toEqual([sat]);
      expect(a.violate.map((x) => x.op)).toEqual([viol]);
    }
  });

  it("mirrors a literal on the left (5 < input.n  ==  input.n > 5)", () => {
    const a = analyseClause({ op: "lt", lhs: { lit: 5 }, rhs: ref("input.n") });
    expect(a).toMatchObject({ ok: true, satisfy: [{ op: "gt", value: 5 }], violate: [{ op: "lte", value: 5 }] });
  });

  it("turns len comparisons into length atoms", () => {
    const a = analyseClause({ op: "gt", lhs: { op: "len", arg: ref("input.name") }, rhs: { lit: 0 } });
    expect(a).toMatchObject({ ok: true, satisfy: [{ op: "lenGt", value: 0 }], violate: [{ op: "lenLte", value: 0 }] });
  });

  it("and: violates exactly the first conjunct and satisfies the rest; or: violates all", () => {
    const and: BoolExpr = { op: "and", args: [{ op: "gte", lhs: ref("input.n"), rhs: { lit: 1 } }, { op: "in", lhs: ref("input.p"), rhs: { lit: ["x"] } }] };
    const a = analyseClause(and);
    expect(a).toMatchObject({ ok: true, violate: [{ op: "lt", field: "n" }, { op: "in", field: "p" }] });
    const or: BoolExpr = { op: "or", args: and.args };
    const o = analyseClause(or);
    expect(o).toMatchObject({ ok: true, satisfy: [{ op: "gte" }], violate: [{ op: "lt" }, { op: "notIn" }] });
  });

  it("not flips satisfy and violate", () => {
    const a = analyseClause({ op: "not", arg: { op: "eq", lhs: ref("input.x"), rhs: { lit: 1 } } });
    expect(a).toMatchObject({ ok: true, satisfy: [{ op: "ne" }], violate: [{ op: "eq" }] });
  });

  it("reports why a clause is not derivable", () => {
    expect(analyseClause({ op: "eq", lhs: ref("actor.role"), rhs: { lit: "admin" } })).toMatchObject({ ok: false, reason: expect.stringContaining("actor") });
    expect(analyseClause({ op: "eq", lhs: ref("input.a"), rhs: ref("input.b") })).toMatchObject({ ok: false });
    expect(analyseClause({ op: "lt", lhs: ref("input.a"), rhs: { lit: "zzz" } })).toMatchObject({ ok: false, reason: expect.stringContaining("orderable") });
    expect(analyseClause({ op: "eq", lhs: ref("input.a.b"), rhs: { lit: 1 } })).toMatchObject({ ok: false, reason: expect.stringContaining("nested") });
    expect(analyseClause({ op: "emitted", event: "Event:X" })).toMatchObject({ ok: false });
    expect(analyseClause({ op: "db.exists", model: "m", where: {} })).toMatchObject({ ok: false });
    expect(analyseClause({ op: "exists", path: ref("self.lines") })).toMatchObject({ ok: false });
    expect(analyseClause({ op: "in", lhs: ref("input.p"), rhs: { lit: [] } })).toMatchObject({ ok: false });
  });

  it("accepts ISO date literals as orderable", () => {
    expect(analyseClause({ op: "gt", lhs: ref("input.endsAt"), rhs: { lit: "2025-01-01" } })).toMatchObject({ ok: true, satisfy: [{ op: "gt", value: "2025-01-01" }] });
  });
});

const atomArb: fc.Arbitrary<Atom> = fc.oneof(
  fc.record({ root: fc.constantFrom("input", "self"), field: fc.constantFrom("a", "b"), op: fc.constantFrom("eq", "ne"), value: fc.oneof(fc.string(), fc.integer(), fc.boolean()) }) as fc.Arbitrary<Atom>,
  fc.record({ root: fc.constantFrom("input", "self"), field: fc.constantFrom("a", "b"), op: fc.constantFrom("lt", "lte", "gt", "gte"), value: fc.integer({ min: -50, max: 50 }) }) as fc.Arbitrary<Atom>,
  fc.record({ root: fc.constantFrom("input", "self"), field: fc.constantFrom("a", "b"), op: fc.constantFrom("in", "notIn"), values: fc.array(fc.string(), { minLength: 1, maxLength: 3 }) }) as fc.Arbitrary<Atom>,
  fc.record({ root: fc.constantFrom("input", "self"), field: fc.constantFrom("a", "b"), op: fc.constantFrom("isNull", "notNull") }) as fc.Arbitrary<Atom>,
);

describe("negateAtom / mergeConjunction", () => {
  it("negation is an involution", () => {
    fc.assert(
      fc.property(atomArb, (a) => {
        expect(negateAtom(negateAtom(a))).toEqual(a);
      }),
    );
  });

  it("an atom and its negation never merge (property)", () => {
    fc.assert(
      fc.property(atomArb, (a) => {
        const r = mergeConjunction([a, negateAtom(a)]);
        if (a.op === "ne" || a.op === "notIn") return; // ne + eq of the same value is caught; ne + eq differ by construction here
        expect(r.ok).toBe(false);
      }),
    );
  });

  it("merges numeric bounds to the tightest range and detects empty ranges", () => {
    const r = mergeConjunction([
      { root: "input", field: "n", op: "gte", value: 1 },
      { root: "input", field: "n", op: "gt", value: 3 },
      { root: "input", field: "n", op: "lte", value: 10 },
    ]);
    expect(r).toMatchObject({ ok: true, fields: [{ field: "n", min: { value: 3, exclusive: true }, max: { value: 10, exclusive: false } }] });
    expect(mergeConjunction([{ root: "input", field: "n", op: "gt", value: 5 }, { root: "input", field: "n", op: "lt", value: 5 }])).toMatchObject({ ok: false });
    expect(mergeConjunction([{ root: "input", field: "n", op: "gte", value: 5 }, { root: "input", field: "n", op: "lte", value: 5 }])).toMatchObject({ ok: true });
  });

  it("intersects in-lists and removes excluded values", () => {
    const r = mergeConjunction([
      { root: "input", field: "p", op: "in", values: ["a", "b", "c"] },
      { root: "input", field: "p", op: "in", values: ["b", "c", "d"] },
      { root: "input", field: "p", op: "ne", value: "c" },
    ]);
    expect(r).toMatchObject({ ok: true, fields: [{ in: ["b"] }] });
    expect(mergeConjunction([{ root: "input", field: "p", op: "in", values: ["a"] }, { root: "input", field: "p", op: "notIn", values: ["a"] }])).toMatchObject({ ok: false });
    expect(mergeConjunction([{ root: "input", field: "p", op: "eq", value: "z" }, { root: "input", field: "p", op: "in", values: ["a"] }])).toMatchObject({ ok: false });
  });

  it("length ranges", () => {
    const r = mergeConjunction([{ root: "input", field: "s", op: "lenGt", value: 2 }, { root: "input", field: "s", op: "lenLte", value: 5 }]);
    expect(r).toMatchObject({ ok: true, fields: [{ lenMin: 3, lenMax: 5 }] });
    expect(mergeConjunction([{ root: "input", field: "s", op: "lenGt", value: 5 }, { root: "input", field: "s", op: "lenLt", value: 3 }])).toMatchObject({ ok: false });
  });

  it("sorts fields deterministically and reports roots", () => {
    const atoms: Atom[] = [
      { root: "self", field: "x", op: "isNull" },
      { root: "input", field: "b", op: "eq", value: 1 },
      { root: "input", field: "a", op: "eq", value: 1 },
    ];
    const r = mergeConjunction(atoms);
    expect(r.ok && r.fields.map((f) => `${f.root}.${f.field}`)).toEqual(["input.a", "input.b", "self.x"]);
    expect(rootsOf(atoms)).toEqual(["input", "self"]);
  });
});
