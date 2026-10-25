/**
 * `db.*` predicate compiler (SPEC-CONTRACTS §5): un-flattening, operator lowering, one `count` per
 * predicate, and the mandatory fail-closed fixtures (b) and (c) from §10.
 */
import { describe, expect, it } from "vitest";
import { db, e } from "@averri/core";
import type { DbWhere } from "@averri/ir";
import { AverriRuntimeError, collectDbNodes, compileWhere, evaluateClause, evaluateDbNode, predicateHolds, unflattenWhere, type DbNode } from "../src/index.js";
import { createFakePrisma } from "./helpers/fake-prisma.js";
import { OwnerOrAdmin, actors, seedTables } from "./helpers/fixtures.js";

const ast = (clause: { ast: unknown }) => clause.ast as never;
const pred = (clause: { ast: unknown }) => clause.ast as DbNode;
const whereOf = (clause: { ast: unknown }) => (clause.ast as { where: DbWhere }).where;

describe("unflattenWhere", () => {
  it("turns dotted keys into nested objects and merges siblings", () => {
    expect(unflattenWhere({ "user.email": "a", "user.name": "b", teamId: "t1", "a.b.c": 1 })).toEqual({
      user: { email: "a", name: "b" },
      teamId: "t1",
      a: { b: { c: 1 } },
    });
  });
});

describe("compileWhere", () => {
  const env = { input: { teamId: "t1", email: "x@acme.io", n: "abc", roles: ["a", "b"] }, actor: { id: "u1" } };

  it("substitutes refs and literals", () => {
    const where = whereOf(db.exists("membership", { teamId: e.input("teamId"), user: { email: e.input("email") }, role: "admin" }));
    expect(compileWhere(where, env)).toEqual({ where: { teamId: "t1", user: { email: "x@acme.io" }, role: "admin" }, undefinedRefs: [] });
  });

  it("lowers operator forms, evaluating e.len() before the call", () => {
    const where = whereOf(
      db.exists("x", {
        role: { in: ["owner", "admin"] },
        tags: { in: e.input("roles") },
        status: { not: "closed" },
        size: { lt: e.len("input.n") },
        created: { gte: e.input("teamId") },
        count: { lte: 5 },
        other: { gt: e.actor("id") },
      }),
    );
    expect(compileWhere(where, env)).toEqual({
      where: {
        role: { in: ["owner", "admin"] },
        tags: { in: ["a", "b"] },
        status: { not: "closed" },
        size: { lt: 3 },
        created: { gte: "t1" },
        count: { lte: 5 },
        other: { gt: "u1" },
      },
      undefinedRefs: [],
    });
  });

  it("lists every undefined ref, including { in: ref } to a non-list and operator operands", () => {
    const where = whereOf(db.exists("x", { a: e.input("missing"), b: { in: e.input("teamId") }, c: { lt: e.len("actor.nope") }, d: { not: e.actor("id") } }));
    const r = compileWhere(where, { input: { teamId: "t1" }, actor: { id: "u1" } });
    expect(r.undefinedRefs).toEqual(["input.missing", "input.teamId", "actor.nope"]);
  });
});

describe("evaluateDbNode / evaluateClause", () => {
  it("db.exists compiles to one count({ where }) and holds when count > 0", async () => {
    const prisma = createFakePrisma(seedTables());
    const node = pred(db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }));
    const r = await evaluateDbNode(node, { input: { teamId: "t1" }, actor: actors.admin }, prisma);
    expect(r).toEqual({ count: 1, undefinedRefs: [], where: { teamId: "t1", userId: "u_admin", role: { in: ["owner", "admin"] } }, skipped: false });
    expect(prisma.$calls).toEqual([{ model: "membership", op: "count", args: { where: r.where }, tx: false }]);
    expect(predicateHolds("db.exists", 1)).toBe(true);
    expect(predicateHolds("db.unique", 2)).toBe(false);
    expect(predicateHolds("db.none", 0)).toBe(true);
  });

  it("(b) db.exists with userId: e.actor('id') undefined is false with undefinedRefs and NO Prisma call", async () => {
    const prisma = createFakePrisma(seedTables());
    const clause = ast(db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }));
    const r = await evaluateClause(clause, { input: { teamId: "t1" }, actor: {} }, prisma);
    expect(r.ok).toBe(false);
    expect(r.undefinedRefs).toEqual(["actor.id"]);
    expect(r.dbCalls).toBe(0);
    expect(prisma.$calls).toEqual([]);
    expect(r.evaluated).toEqual({ "": { lhs: null, rhs: "count > 0" } });
  });

  it("(c) db.none with an undefined ref is false (never true) and performs no call", async () => {
    const prisma = createFakePrisma(seedTables());
    const clause = ast(db.none("membership", { teamId: e.input("teamId"), userId: e.actor("id") }));
    const r = await evaluateClause(clause, { input: { teamId: "t1" }, actor: null }, prisma);
    expect(r.ok).toBe(false);
    expect(r.undefinedRefs).toEqual(["actor.id"]);
    expect(prisma.$calls).toEqual([]);
  });

  it("db.unique and db.countWhere (a skipped countWhere poisons the clause, D-41a)", async () => {
    const prisma = createFakePrisma(seedTables());
    expect((await evaluateClause(ast(db.unique("membership", { teamId: "t1", role: "admin" })), {}, prisma)).ok).toBe(true);
    expect((await evaluateClause(ast(db.unique("membership", { teamId: "t1" })), {}, prisma)).ok).toBe(false);
    const cmp = await evaluateClause(ast(e.lt(db.countWhere("membership", { teamId: e.input("teamId") }), 3)), { input: { teamId: "t1" } }, prisma);
    expect(cmp.ok).toBe(true);
    expect(cmp.evaluated).toEqual({ "": { lhs: 2, rhs: 3 } });
    prisma.$reset();
    const zero = await evaluateClause(ast(e.eq(db.countWhere("membership", { teamId: e.input("nope") }), 0)), { input: {} }, prisma);
    expect(zero.ok).toBe(false);
    expect(zero.undefinedRefs).toEqual(["input.nope"]);
    expect(prisma.$calls).toEqual([]);
  });

  it("fail closed: a Prisma error or an undefined ref never lets countWhere or not(db.*) pass", async () => {
    const failing = createFakePrisma(seedTables(), { failCount: ["membership"] });
    const ok = createFakePrisma(seedTables());
    // countWhere on a throwing client: the old code read the null count as 0 and passed `<= 2`
    const count = ast(e.lte(db.countWhere("membership", { userId: e.actor("id") }), 2));
    const countErr = await evaluateClause(count, { actor: { id: "u1" } }, failing);
    expect(countErr.ok).toBe(false);
    expect(countErr.errors[0]).toMatch(/count failed/);
    expect((await evaluateClause(count, { actor: { id: "u1" } }, ok)).ok).toBe(true);
    // not(db.exists) on a throwing client: the fail-closed false used to be flipped to true
    const banned = ast(e.not(db.exists("membership", { userId: e.actor("id"), role: "banned" })));
    expect((await evaluateClause(banned, { actor: { id: "u1" } }, failing)).ok).toBe(false);
    expect((await evaluateClause(banned, { actor: { id: "u1" } }, ok)).ok).toBe(true);
    // not(db.exists) with an undefined ref: SPEC-CONTRACTS §5 requires fail closed, not "not a banned member"
    const undef = await evaluateClause(banned, { actor: {} }, ok);
    expect(undef.ok).toBe(false);
    expect(undef.undefinedRefs).toEqual(["actor.id"]);
    expect(ok.$calls).toEqual([expect.objectContaining({ model: "membership" }), expect.objectContaining({ model: "membership" })]);
    // evaluateContract / evaluatePolicy (the pipeline entry points) never report ok when errors were raised
    const nested = ast(e.and(e.eq("input.x", 1), e.or(e.not(db.none("membership", { userId: e.actor("id") })), e.eq("input.y", 2))));
    expect((await evaluateClause(nested, { input: { x: 1, y: 2 }, actor: { id: "u1" } }, failing)).ok).toBe(false);
  });

  it("mixed clauses run one count per predicate and combine with expressions", async () => {
    const prisma = createFakePrisma(seedTables());
    const clause = ast(e.and(e.eq("input.role", "member"), db.exists("team", { id: e.input("teamId") }), db.none("invitation", { email: e.input("email") })));
    const r = await evaluateClause(clause, { input: { role: "member", teamId: "t1", email: "new@acme.io" } }, prisma);
    expect(r.ok).toBe(true);
    expect(r.dbCalls).toBe(2);
    expect(prisma.$calls.map((c) => c.model)).toEqual(["team", "invitation"]);
    expect(collectDbNodes(clause).length).toBe(2);
  });

  it("an unknown model accessor throws from evaluateDbNode and fails closed through evaluateClause", async () => {
    const prisma = createFakePrisma({});
    const bare = { nothing: true } as unknown as object;
    await expect(evaluateDbNode(pred(db.exists("ghost", { id: "x" })), {}, bare)).rejects.toBeInstanceOf(AverriRuntimeError);
    const r = await evaluateClause(ast(db.exists("ghost", { id: "x" })), {}, bare);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/no model accessor "ghost"/);
    // the fake accepts any model name, so this one succeeds with 0 rows
    expect((await evaluateClause(ast(db.none("ghost", { id: "x" })), {}, prisma)).ok).toBe(true);
  });

  it("a Prisma failure inside count() is a failed predicate, not an exception", async () => {
    const prisma = createFakePrisma(seedTables(), { failCount: ["membership"] });
    const r = await evaluateClause(ast(db.exists("membership", { teamId: "t1" })), {}, prisma);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/count failed/);
  });

  it("the OwnerOrAdmin policy where round-trips through the marker", () => {
    const where = (OwnerOrAdmin.options.allow as { ast: { where: DbWhere } }).ast.where;
    expect(Object.keys(where)).toEqual(["teamId", "userId", "role"]);
  });
});
