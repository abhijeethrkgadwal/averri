import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  BoolExprSchema,
  canonicalJson,
  collectDbModels,
  collectDbPredicates,
  collectEmittedEvents,
  collectOps,
  collectRefRoots,
  collectRefs,
  containsDbOp,
  exprDepth,
  exprEquals,
  hasOp,
  isDbOp,
  isLit,
  isRef,
  opOf,
  refRoot,
  refSegments,
  renderExpr,
  stableHash,
  tierOf,
  walkExpr,
  whereLeaves,
  type BoolExpr,
  type ContractExpr,
  type DbWhere,
} from "../src/index.js";
import { boolExprArb } from "./arbitraries.js";

const predicate: BoolExpr = {
  op: "and",
  args: [
    { op: "eq", lhs: { ref: "input.role" }, rhs: { lit: "member" } },
    { op: "db.none", model: "membership", where: { teamId: { ref: "input.teamId" }, "user.email": { ref: "input.email" }, role: { in: { lit: ["a", "b"] } }, n: { lt: { op: "len", arg: { ref: "self.name" } } } } },
    { op: "not", arg: { op: "emitted", event: "Event:MemberInvited", count: 2 } },
  ],
};

describe("tierOf / isDbOp", () => {
  it("derives the tier per SPEC-CONTRACTS §3", () => {
    expect(tierOf(async () => true)).toBe("guard");
    expect(tierOf(null)).toBe("guard");
    expect(tierOf(undefined)).toBe("guard");
    expect(tierOf({ op: "eq", lhs: { ref: "input.a" }, rhs: { lit: 1 } })).toBe("expr");
    expect(tierOf(predicate)).toBe("predicate");
    expect(tierOf({ op: "gt", lhs: { op: "db.countWhere", model: "x", where: {} }, rhs: { lit: 1 } })).toBe("predicate");
    expect(tierOf({ op: "exists", path: { ref: "self.lines" }, where: { op: "db.exists", model: "x", where: {} } })).toBe("predicate");
  });
  it("isDbOp", () => {
    for (const op of ["db.exists", "db.none", "db.unique", "db.countWhere"]) expect(isDbOp(op)).toBe(true);
    for (const op of ["exists", "eq", "db", "db.foo"]) expect(isDbOp(op)).toBe(false);
  });
});

describe("walkExpr", () => {
  it("visits every node including where leaves, with paths and polarity", () => {
    const seen: Array<[string, string, number, boolean, string | null]> = [];
    walkExpr(predicate, (n, ctx) => {
      seen.push([opOf(n), ctx.path.join("."), ctx.negations, ctx.inWhere, ctx.whereKey]);
    });
    expect(seen).toContainEqual(["and", "", 0, false, null]);
    expect(seen).toContainEqual(["ref", "args.0.lhs", 0, false, null]);
    expect(seen).toContainEqual(["ref", "args.1.where.user.email", 0, true, "user.email"]);
    expect(seen).toContainEqual(["lit", "args.1.where.role.in", 0, true, "role"]);
    expect(seen).toContainEqual(["len", "args.1.where.n.lt", 0, true, "n"]);
    expect(seen).toContainEqual(["ref", "args.1.where.n.lt.arg", 0, true, "n"]);
    expect(seen).toContainEqual(["emitted", "args.2.arg", 1, false, null]);
    expect(seen.length).toBe(12);
  });
  it("returning false prunes children", () => {
    const ops: string[] = [];
    walkExpr(predicate, (n) => {
      ops.push(opOf(n));
      if (hasOp(n) && n.op === "db.none") return false;
    });
    expect(ops).not.toContain("len");
    expect(ops).toContain("emitted");
  });
  it("covers every operator shape", () => {
    const all: BoolExpr = {
      op: "or",
      args: [
        { op: "in", lhs: { ref: "input.x" }, rhs: { ref: "self.list" } },
        { op: "isNull", arg: { ref: "self.a" } },
        { op: "exists", path: { ref: "self.lines" }, where: { op: "gte", lhs: { op: "sum", path: { ref: "self.lines" }, field: "amount" }, rhs: { op: "count", path: { ref: "self.lines" }, where: { op: "ne", lhs: { ref: "self.q" }, rhs: { lit: null } } } } },
        { op: "exists", path: { ref: "self.other" } },
        { op: "lte", lhs: { op: "db.countWhere", model: "m", where: { a: { not: { lit: 1 } }, b: { gt: { lit: 2 } }, c: { gte: { lit: 3 } }, d: { lte: { lit: 4 } } } }, rhs: { lit: 3 } },
        { op: "db.unique", model: "m", where: {} },
        { op: "db.exists", model: "m", where: { k: { lit: true } } },
      ],
    };
    expect(collectOps(all)).toEqual(["or", "in", "isNull", "exists", "gte", "sum", "count", "ne", "lte", "db.countWhere", "db.unique", "db.exists"]);
    expect(collectRefs(all)).toEqual(["input.x", "self.a", "self.lines", "self.list", "self.other", "self.q"]);
    expect(exprDepth(all)).toBe(6);
    expect(exprDepth({ op: "isNull", arg: { ref: "self.a" } })).toBe(2);
  });
});

describe("collectors", () => {
  it("collectRefs is sorted and unique and includes where refs", () => {
    expect(collectRefs(predicate)).toEqual(["input.email", "input.role", "input.teamId", "self.name"]);
    expect(collectRefRoots(predicate)).toEqual(["input", "self"]);
  });
  it("collectDbModels / collectDbPredicates / collectEmittedEvents / containsDbOp", () => {
    expect(collectDbModels(predicate)).toEqual(["membership"]);
    expect(collectDbPredicates(predicate)).toHaveLength(1);
    expect(collectDbPredicates(predicate)[0]).toMatchObject({ op: "db.none", model: "membership" });
    expect(collectEmittedEvents(predicate)).toEqual(["Event:MemberInvited"]);
    expect(containsDbOp(predicate)).toBe(true);
    expect(containsDbOp({ op: "isNull", arg: { ref: "self.a" } })).toBe(false);
  });
  it("refRoot / refSegments", () => {
    expect(refRoot("self.lines.amount")).toBe("self");
    expect(refRoot("nope.x")).toBeNull();
    expect(refRoot("input")).toBe("input");
    expect(refSegments("self.lines.amount")).toEqual(["lines", "amount"]);
  });
  it("whereLeaves lists bare values and operator operands", () => {
    const where: DbWhere = { a: { ref: "input.a" }, b: { lit: 1 }, c: { in: { lit: [1] } }, d: { not: { ref: "actor.id" } }, e: { lt: { lit: 1 } } };
    expect(whereLeaves(where).map((l) => `${l.key}:${l.operator ?? "="}`)).toEqual(["a:=", "b:=", "c:in", "d:not", "e:lt"]);
  });
  it("isRef / isLit / hasOp / opOf", () => {
    expect(isRef({ ref: "input.a" })).toBe(true);
    expect(isRef({ lit: 1 })).toBe(false);
    expect(isLit({ lit: null })).toBe(true);
    expect(isLit(null)).toBe(false);
    expect(hasOp({ op: "len", arg: { ref: "input.a" } })).toBe(true);
    expect(opOf({ lit: 1 })).toBe("lit");
  });
});

describe("canonicalJson / stableHash / exprEquals", () => {
  it("sorts keys, drops undefined, keeps arrays", () => {
    expect(canonicalJson({ b: 1, a: [3, { z: 1, y: undefined }], u: undefined })).toBe('{"a":[3,{"z":1}],"b":1}');
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
    expect(canonicalJson({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
    expect(canonicalJson(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(10n)).toThrow(/bigint/);
  });
  it("is key-order independent and hashes stably", () => {
    const a = { op: "eq", lhs: { ref: "input.a" }, rhs: { lit: 1 } };
    const b = { rhs: { lit: 1 }, op: "eq", lhs: { ref: "input.a" } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(stableHash(a)).toBe(stableHash(b));
    expect(stableHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(stableHash({ op: "eq", lhs: { ref: "input.a" }, rhs: { lit: 2 } })).not.toBe(stableHash(a));
    expect(exprEquals(a, b)).toBe(true);
  });
  it("property: canonicalJson is idempotent and key-order invariant for ASTs", () => {
    fc.assert(
      fc.property(boolExprArb(), (expr) => {
        const once = canonicalJson(expr);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
        expect(canonicalJson(shuffleKeys(expr))).toBe(once);
        expect(BoolExprSchema.safeParse(JSON.parse(once)).success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
  it("property: collectRefs equals the refs found by a naive JSON scan", () => {
    fc.assert(
      fc.property(boolExprArb(), (expr) => {
        const naive = new Set<string>();
        JSON.stringify(expr, (_k, v: unknown) => {
          if (typeof v === "object" && v !== null && "ref" in v && typeof (v as { ref: unknown }).ref === "string" && !("op" in v)) naive.add((v as { ref: string }).ref);
          return v;
        });
        expect(collectRefs(expr)).toEqual([...naive].sort());
        expect(tierOf(expr)).toBe(JSON.stringify(expr).includes('"op":"db.') ? "predicate" : "expr");
      }),
      { numRuns: 200 },
    );
  });
});

describe("renderExpr", () => {
  it("renders readable text", () => {
    expect(renderExpr(predicate)).toBe(
      'input.role == "member" and db.none(membership where teamId = input.teamId, user.email = input.email, role in ["a","b"], n lt len(self.name)) and not emitted Event:MemberInvited x2',
    );
    expect(renderExpr({ op: "or", args: [{ op: "and", args: [{ op: "isNull", arg: { ref: "self.a" } }] }, { op: "exists", path: { ref: "self.l" } }] })).toBe("(self.a is null) or exists(self.l)");
    expect(renderExpr({ op: "emitted", event: "Event:X", count: { min: 1, max: 3 } })).toBe("emitted Event:X x[1..3]");
    expect(renderExpr({ op: "emitted", event: "Event:X", count: { max: 3 } })).toBe("emitted Event:X x[0..3]");
    expect(renderExpr({ op: "emitted", event: "Event:X" })).toBe("emitted Event:X");
    expect(renderExpr({ op: "gte", lhs: { op: "sum", path: { ref: "self.lines" }, field: "amount" }, rhs: { op: "count", path: { ref: "self.lines" } } })).toBe("sum(self.lines.amount) >= count(self.lines)");
    expect(renderExpr({ op: "ne", lhs: { op: "count", path: { ref: "self.lines" }, where: { op: "isNull", arg: { ref: "self.x" } } }, rhs: { lit: 0 } })).toBe("count(self.lines where self.x is null) != 0");
    expect(renderExpr({ op: "exists", path: { ref: "self.l" }, where: { op: "in", lhs: { ref: "self.k" }, rhs: { lit: [1] } } })).toBe("exists(self.l where self.k in [1])");
  });
});

function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v)]));
  }
  return value as ContractExpr;
}
