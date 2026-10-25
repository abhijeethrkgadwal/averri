/**
 * `e.*` and `db.*` build the exact serializable AST from @averri/ir (SPEC-CONTRACTS §4–5):
 * canonical node key order, root-qualified paths, flat `where`, tier derivation, frozen output,
 * and precise rejections for everything the types forbid.
 */
import { describe, expect, it } from "vitest";
import { BoolExprSchema, OperandSchema, DbWhereSchema, type CompareExpr, type DbPredicate } from "@averri/ir";
import { AverriDeclarationError, db, e, event, tierOf, flattenWhere, normalisePath, collectRefs, isLitScalar } from "../src/index.js";

const MemberInvited = event("MemberInvited", { payload: { invitationId: "string" } });

function keys(value: unknown): string[] {
  return Object.keys(value as object);
}

describe("e.* value forms", () => {
  it("builds root-qualified refs without re-rooting the field", () => {
    expect(e.input("teamId")).toEqual({ tier: "value", ast: { ref: "input.teamId" } });
    expect(e.actor("id").ast).toEqual({ ref: "actor.id" });
    expect(e.self("status").ast).toEqual({ ref: "self.status" });
    expect(e.old("status").ast).toEqual({ ref: "old.status" });
    expect(e.result("email").ast).toEqual({ ref: "result.email" });
    expect(e.input("user.email").ast).toEqual({ ref: "input.user.email" });
    // a doubled prefix is NOT normalised (A3002 with a deterministic fix in the compiler)
    expect(e.input("input.teamId").ast).toEqual({ ref: "input.input.teamId" });
  });

  it("builds literals, len, sum and count with canonical key order", () => {
    expect(e.lit("x").ast).toEqual({ lit: "x" });
    expect(e.lit(null).ast).toEqual({ lit: null });
    expect(e.len("self.lines").ast).toEqual({ op: "len", arg: { ref: "self.lines" } });
    expect(e.len(e.input("name")).ast).toEqual({ op: "len", arg: { ref: "input.name" } });
    expect(e.sum("lines", "amount").ast).toEqual({ op: "sum", path: { ref: "self.lines" }, field: "amount" });
    expect(keys(e.sum("lines", "amount").ast)).toEqual(["op", "path", "field"]);
    expect(e.count("result.lines").ast).toEqual({ op: "count", path: { ref: "result.lines" } });
    const filtered = e.count("lines", e.gt("amount", 0));
    expect(filtered.ast).toEqual({ op: "count", path: { ref: "self.lines" }, where: { op: "gt", lhs: { ref: "self.amount" }, rhs: { lit: 0 } } });
    expect(keys(filtered.ast)).toEqual(["op", "path", "where"]);
    for (const value of [e.lit(1), e.len("a"), e.sum("a", "b"), e.count("a")]) OperandSchema.parse(value.ast);
  });

  it("rejects invalid refs and literals", () => {
    expect(() => e.input("")).toThrow(AverriDeclarationError);
    expect(() => e.input("a.b.c.d")).toThrow(/deeper than 3 segments/);
    expect(() => e.actor("a b")).toThrow(/invalid segment/);
    expect(() => e.lit(Number.NaN as never)).toThrow(/finite number/);
    expect(() => e.lit({} as never)).toThrow(/expected a literal/);
    expect(() => e.lit(undefined as never)).toThrow(AverriDeclarationError);
    expect(() => e.len(e.lit("x") as never)).toThrow(/expected a path string or a reference/);
    expect(() => e.sum("lines", "" as never)).toThrow(/expected a field name/);
    expect(() => e.count("lines", db.exists("team", {}) as never)).toThrow(/expression-tier only|no db\.\* inside/);
    expect(() => e.count("lines", (async () => true) as never)).toThrow(/guard/);
  });
});

describe("e.* comparisons (the one-line rule)", () => {
  it("lhs strings are paths, rhs strings are literals", () => {
    const c = e.eq("result.email", e.input("email"));
    expect(c).toEqual({ tier: "expr", ast: { op: "eq", lhs: { ref: "result.email" }, rhs: { ref: "input.email" } } });
    expect(keys(c.ast)).toEqual(["op", "lhs", "rhs"]);
    expect(e.eq("result.status", "pending").ast).toEqual({ op: "eq", lhs: { ref: "result.status" }, rhs: { lit: "pending" } });
    expect(e.ne("status", "pending").ast).toEqual({ op: "ne", lhs: { ref: "self.status" }, rhs: { lit: "pending" } });
    expect(e.lt("input.qty", 10).ast.op).toBe("lt");
    expect(e.lte(e.len("input.name"), 80).ast).toEqual({ op: "lte", lhs: { op: "len", arg: { ref: "input.name" } }, rhs: { lit: 80 } });
    expect((e.gt("self.balance", e.lit(0)).ast as CompareExpr).rhs).toEqual({ lit: 0 });
    expect((e.gte("self.balance", null).ast as CompareExpr).rhs).toEqual({ lit: null });
    expect((e.eq("self.active", true).ast as CompareExpr).rhs).toEqual({ lit: true });
  });

  it("validates every comparison against the IR schema", () => {
    for (const clause of [
      e.eq("a", "b"),
      e.ne("input.a", 1),
      e.lt("a", e.input("b")),
      e.lte(e.sum("lines", "amount"), 100),
      e.gt(e.count("lines"), 0),
      e.gte(db.countWhere("membership", { teamId: e.input("teamId") }), 1),
    ]) {
      BoolExprSchema.parse(clause.ast);
    }
  });

  it("rejects malformed operands", () => {
    expect(() => e.eq(1 as never, 1)).toThrow(/option "lhs"/);
    expect(() => e.eq("a", undefined as never)).toThrow(/option "rhs"/);
    expect(() => e.eq("a", {} as never)).toThrow(/expected a literal/);
    expect(() => e.eq("a", e.eq("b", 1) as never)).toThrow(/boolean clause/);
    expect(() => e.eq("a", Number.POSITIVE_INFINITY)).toThrow(/finite number/);
    expect(() => e.eq("", 1)).toThrow(/non-empty path/);
  });
});

describe("e.and / e.or / e.not / e.in / e.isNull / e.exists / e.emitted", () => {
  it("composes with canonical key order and derives the tier from the parts", () => {
    const and = e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending"));
    expect(and.tier).toBe("expr");
    expect(keys(and.ast)).toEqual(["op", "args"]);
    expect(and.ast).toEqual({
      op: "and",
      args: [
        { op: "eq", lhs: { ref: "result.email" }, rhs: { ref: "input.email" } },
        { op: "eq", lhs: { ref: "result.status" }, rhs: { lit: "pending" } },
      ],
    });
    const or = e.or(e.ne("status", "pending"), e.isNull("acceptedAt"));
    expect(or.ast).toEqual({ op: "or", args: [{ op: "ne", lhs: { ref: "self.status" }, rhs: { lit: "pending" } }, { op: "isNull", arg: { ref: "self.acceptedAt" } }] });
    const not = e.not(e.isNull(e.result("id")));
    expect(not.ast).toEqual({ op: "not", arg: { op: "isNull", arg: { ref: "result.id" } } });
    const mixed = e.and(e.eq("input.role", "member"), db.exists("team", { id: e.input("teamId") }));
    expect(mixed.tier).toBe("predicate");
    expect(e.not(mixed).tier).toBe("predicate");
    expect(e.or(and, e.not(mixed)).tier).toBe("predicate");
    expect(e.and(e.gte(db.countWhere("membership", {}), 1)).tier).toBe("predicate");
    for (const c of [and, or, not, mixed]) BoolExprSchema.parse(c.ast);
  });

  it("builds in / isNull / exists / emitted", () => {
    expect(e.in("input.role", ["admin", "member"]).ast).toEqual({ op: "in", lhs: { ref: "input.role" }, rhs: { lit: ["admin", "member"] } });
    expect(e.in("input.role", e.actor("roles")).ast).toEqual({ op: "in", lhs: { ref: "input.role" }, rhs: { ref: "actor.roles" } });
    expect(e.isNull("acceptedAt").ast).toEqual({ op: "isNull", arg: { ref: "self.acceptedAt" } });
    expect(e.isNull(e.input("x")).ast).toEqual({ op: "isNull", arg: { ref: "input.x" } });
    expect(e.exists("result.lines").ast).toEqual({ op: "exists", path: { ref: "result.lines" } });
    expect(e.exists("lines", e.eq("kind", "tax")).ast).toEqual({
      op: "exists",
      path: { ref: "self.lines" },
      where: { op: "eq", lhs: { ref: "self.kind" }, rhs: { lit: "tax" } },
    });
    expect(e.emitted(MemberInvited).ast).toEqual({ op: "emitted", event: "Event:MemberInvited" });
    expect(e.emitted(MemberInvited, 1).ast).toEqual({ op: "emitted", event: "Event:MemberInvited", count: 1 });
    expect(e.emitted(MemberInvited, { min: 1, max: 2 }).ast).toEqual({ op: "emitted", event: "Event:MemberInvited", count: { min: 1, max: 2 } });
    expect(e.emitted(MemberInvited, { max: 0 }).ast).toEqual({ op: "emitted", event: "Event:MemberInvited", count: { max: 0 } });
    for (const c of [e.in("a", [1]), e.isNull("a"), e.exists("a"), e.emitted(MemberInvited, 2)]) BoolExprSchema.parse(c.ast);
  });

  it("rejects guards, empty composites and bad arguments", () => {
    expect(() => (e.and as (...a: unknown[]) => unknown)()).toThrow(/at least one clause/);
    expect(() => (e.or as (...a: unknown[]) => unknown)()).toThrow(/at least one clause/);
    expect(() => e.and(e.eq("a", 1), (async () => true) as never)).toThrow(/guard.*cannot be combined/);
    expect(() => e.not((() => true) as never)).toThrow(/guard/);
    expect(() => e.or(e.eq("a", 1), { tier: "expr" } as never)).toThrow(/expected a clause/);
    expect(() => e.and(e.eq("a", 1), "x" as never)).toThrow(/args\[1\]/);
    expect(() => e.in("a", e.sum("lines", "amount") as never)).toThrow(/literal list or a reference/);
    expect(() => e.in("a", "admin" as never)).toThrow(/array of literals/);
    expect(() => e.in("a", [1, {}] as never)).toThrow(/element 1/);
    expect(() => e.isNull(e.lit(1) as never)).toThrow(/path string or a reference/);
    expect(() => e.exists("lines", db.none("t", {}) as never)).toThrow(/expression-tier/);
    expect(() => e.emitted({ kind: "event", name: "X" } as never)).toThrow(/event\(\) declaration/);
    expect(() => e.emitted(MemberInvited, -1)).toThrow(/non-negative integer/);
    expect(() => e.emitted(MemberInvited, 1.5)).toThrow(/non-negative integer/);
    expect(() => e.emitted(MemberInvited, { min: 3, max: 1 })).toThrow(/greater than max/);
    expect(() => e.emitted(MemberInvited, {})).toThrow(/at least one of min, max/);
    expect(() => e.emitted(MemberInvited, { min: -1 })).toThrow(/count\.min/);
    expect(() => e.emitted(MemberInvited, { exactly: 1 } as never)).toThrow(/unknown keys/);
    expect(() => e.emitted(MemberInvited, "1" as never)).toThrow(/number or \{ min\?, max\? \}/);
  });
});

describe("db.* predicates", () => {
  it("flattens nested where objects into canonical dotted keys in source order", () => {
    const none = db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } });
    expect(none).toEqual({
      tier: "predicate",
      ast: { op: "db.none", model: "membership", where: { teamId: { ref: "input.teamId" }, "user.email": { ref: "input.email" } } },
    });
    expect(keys(none.ast)).toEqual(["op", "model", "where"]);
    expect(keys((none.ast as DbPredicate).where)).toEqual(["teamId", "user.email"]);
    const deep = db.exists("invitation", { team: { org: { slug: "acme" } }, status: "pending" });
    expect((deep.ast as DbPredicate).where).toEqual({ "team.org.slug": { lit: "acme" }, status: { lit: "pending" } });
    BoolExprSchema.parse(none.ast);
    BoolExprSchema.parse(deep.ast);
  });

  it("lowers operator forms", () => {
    const where = (db.exists("membership", {
      teamId: e.input("teamId"),
      userId: e.actor("id"),
      role: { in: ["owner", "admin"] },
      status: { not: "banned" },
      seats: { lt: 10 },
      createdAt: { lte: e.input("before") },
      score: { gt: e.len("input.name") },
      level: { gte: e.lit(2) },
      tags: { in: e.input("tags") },
      ownerId: { not: e.actor("id") },
      nothing: null,
      flag: true,
    }).ast as DbPredicate).where;
    expect(where).toEqual({
      teamId: { ref: "input.teamId" },
      userId: { ref: "actor.id" },
      role: { in: { lit: ["owner", "admin"] } },
      status: { not: { lit: "banned" } },
      seats: { lt: { lit: 10 } },
      createdAt: { lte: { ref: "input.before" } },
      score: { gt: { op: "len", arg: { ref: "input.name" } } },
      level: { gte: { lit: 2 } },
      tags: { in: { ref: "input.tags" } },
      ownerId: { not: { ref: "actor.id" } },
      nothing: { lit: null },
      flag: { lit: true },
    });
    DbWhereSchema.parse(where);
  });

  it("builds exists / unique / countWhere and accepts an empty where", () => {
    expect(db.exists("team", {}).ast).toEqual({ op: "db.exists", model: "team", where: {} });
    expect(db.unique("team", { id: e.input("id") }).ast.op).toBe("db.unique");
    const count = db.countWhere("membership", { teamId: e.input("teamId") });
    expect(count).toEqual({ tier: "dbvalue", ast: { op: "db.countWhere", model: "membership", where: { teamId: { ref: "input.teamId" } } } });
    OperandSchema.parse(count.ast);
    const clause = e.lte(count, 50);
    expect(clause.tier).toBe("predicate");
    expect(tierOf(clause)).toBe("predicate");
  });

  it("rejects malformed models and where clauses with precise messages", () => {
    expect(() => db.exists("" as never, {})).toThrow(/Prisma client accessor name/);
    expect(() => db.exists("my model" as never, {})).toThrow(/not an identifier/);
    expect(() => db.exists("team", null as never)).toThrow(/expected a where object/);
    expect(() => db.exists("team", [] as never)).toThrow(/expected a where object/);
    expect(() => db.exists("team", { id: undefined as never })).toThrow(/undefined/);
    expect(() => db.exists("team", { in: ["a"] } as never)).toThrow(/operator keyword/);
    expect(() => db.exists("team", { "bad key": 1 } as never)).toThrow(/not an identifier/);
    expect(() => db.exists("team", { a: { b: { c: { d: 1 } } } })).toThrow(/deeper than 3 segments/);
    expect(() => db.exists("team", { user: {} })).toThrow(/nested where object is empty/);
    expect(() => db.exists("team", { role: { in: ["a"], not: "b" } } as never)).toThrow(/exactly one of/);
    expect(() => db.exists("team", { role: { in: "admin" } } as never)).toThrow(/array of literals or a reference/);
    expect(() => db.exists("team", { role: { in: e.len("x") } } as never)).toThrow(/array of literals or a reference/);
    expect(() => db.exists("team", { role: { not: e.len("x") } } as never)).toThrow(/not e\.len/);
    expect(() => db.exists("team", { n: { lt: e.sum("lines", "amount") } } as never)).toThrow(/e\.sum\(\) cannot appear inside a where/);
    expect(() => db.exists("team", { n: { gt: db.countWhere("x", {}) } } as never)).toThrow(/db\.countWhere\(\) cannot appear inside a where/);
    expect(() => db.exists("team", { n: e.count("lines") } as never)).toThrow(/cannot appear inside a where/);
    expect(() => db.exists("team", { n: e.eq("a", 1) } as never)).toThrow(/not boolean clauses/);
    expect(() => db.exists("team", { n: () => true } as never)).toThrow(/unsupported where value/);
    expect(() => db.exists("team", { n: { lte: {} } } as never)).toThrow(/option "where\.n\.lte"/);
    expect(() => db.exists("team", { n: Number.NaN } as never)).toThrow(/unsupported where value/);
  });
});

describe("builder output is frozen and pure data", () => {
  it("freezes clauses, values and nested AST nodes", () => {
    const clause = e.and(e.eq("a", 1), db.exists("t", { x: { in: [1, 2] } }));
    expect(Object.isFrozen(clause)).toBe(true);
    expect(Object.isFrozen(clause.ast)).toBe(true);
    expect(Object.isFrozen((clause.ast as { args: unknown[] }).args)).toBe(true);
    const predicate = db.exists("t", { x: { in: [1, 2] } });
    expect(Object.isFrozen((predicate.ast as DbPredicate).where)).toBe(true);
    expect(Object.isFrozen(((predicate.ast as DbPredicate).where.x as { in: { lit: unknown[] } }).in.lit)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(db)).toBe(true);
    expect(JSON.parse(JSON.stringify(clause))).toEqual(clause);
  });

  it("does not mutate the caller's where object", () => {
    const where = { user: { email: e.input("email") }, role: { in: ["a"] } };
    const snapshot = JSON.stringify(where);
    db.none("membership", where);
    expect(JSON.stringify(where)).toBe(snapshot);
  });
});

describe("exported AST helpers", () => {
  it("normalisePath, flattenWhere, collectRefs, isLitScalar", () => {
    expect(normalisePath("t", null, "status")).toBe("self.status");
    expect(normalisePath("t", null, "result.a.b")).toBe("result.a.b");
    expect(normalisePath("t", null, "input")).toBe("self.input");
    expect(flattenWhere("t", "where", { a: { b: 1 } })).toEqual({ "a.b": { lit: 1 } });
    const refs = collectRefs(e.and(e.eq("input.a", e.actor("b")), e.exists("lines", e.eq("kind", "x")), db.exists("t", { u: { id: e.input("c") } })).ast);
    expect(refs.map((r) => [r.ref, r.inElementScope])).toEqual([
      ["input.a", false],
      ["actor.b", false],
      ["self.lines", false],
      ["self.kind", true],
      ["input.c", false],
    ]);
    expect(isLitScalar("x") && isLitScalar(1) && isLitScalar(false) && isLitScalar(null)).toBe(true);
    expect(isLitScalar(undefined) || isLitScalar({}) || isLitScalar(Number.NaN)).toBe(false);
    expect(tierOf(async () => true)).toBe("guard");
    expect(tierOf(e.eq("a", 1))).toBe("expr");
  });
});
