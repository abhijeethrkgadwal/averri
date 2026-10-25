/**
 * Guard runner (SPEC-CONTRACTS §6) and phase evaluation over ContractRecords: tier order, every clause
 * evaluated, first failure reported, policy evaluation for the auth matrix.
 */
import { describe, expect, it } from "vitest";
import { averriMeta, db, e, policy, type ContractRecord } from "@averri/core";
import { evaluateContract, evaluateInvariants, evaluatePhase, evaluatePolicy, orderByTier, runGuard } from "../src/index.js";
import { createFakePrisma } from "./helpers/fake-prisma.js";
import { Invitation, OwnerOrAdmin, actors, inviteMember, seedTables } from "./helpers/fixtures.js";

describe("runGuard", () => {
  it("passes only on `true`, receives the typed context with the PLAIN client", async () => {
    const prisma = createFakePrisma({});
    let seen: unknown;
    const r = await runGuard(
      async (ctx) => {
        seen = ctx;
        return true;
      },
      { input: { a: 1 }, actor: actors.admin, self: { id: "s" }, old: null, result: undefined, prisma },
    );
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(seen).toMatchObject({ input: { a: 1 }, actor: actors.admin, self: { id: "s" }, old: null, result: undefined });
    expect((seen as { prisma: unknown }).prisma).toBe(prisma);
  });

  it("fails closed on false, throw, rejection and non-boolean returns", async () => {
    const base = { input: {}, actor: null, self: null, old: null, result: undefined, prisma: null };
    expect((await runGuard(async () => false, base)).ok).toBe(false);
    const thrown = await runGuard(() => {
      throw new Error("boom");
    }, base);
    expect(thrown).toMatchObject({ ok: false, error: "guard threw: boom" });
    expect((await runGuard(() => Promise.reject(new Error("later")), base)).error).toBe("guard threw: later");
    expect((await runGuard((() => "yes") as never, base)).error).toMatch(/returned string/);
    expect((await runGuard((() => 1) as never, base)).ok).toBe(false);
  });
});

describe("evaluatePhase", () => {
  const records = (decl = inviteMember()): readonly ContractRecord[] => averriMeta(decl).contracts;

  it("orders expr, predicate, guard (stable within a tier)", () => {
    const decl = inviteMember({
      requires: {
        g1: async () => true,
        p1: db.exists("team", { id: "t1" }),
        x1: e.eq("input.role", "member"),
        g2: async () => true,
        x2: e.eq("input.role", "member"),
      },
    });
    expect(orderByTier(records(decl).filter((c) => c.phase === "requires")).map((c) => c.clause)).toEqual(["x1", "x2", "p1", "g1", "g2"]);
  });

  it("evaluates every clause and reports the first failure in tier order", async () => {
    const prisma = createFakePrisma(seedTables());
    let guardCalls = 0;
    const decl = inviteMember({
      requires: {
        failingGuard: async () => {
          guardCalls += 1;
          return false;
        },
        failingExpr: e.eq("input.role", "owner"),
        passingPredicate: db.exists("team", { id: e.input("teamId") }),
      },
    });
    const requires = records(decl).filter((c) => c.phase === "requires");
    const r = await evaluatePhase("requires", requires, { input: { role: "member", teamId: "t1" }, actor: actors.admin }, { prisma });
    expect(r.records.map((p) => [p.contract, p.ok, p.tier])).toEqual([
      ["Contract:Team.inviteMember.requires.failingExpr", false, "expr"],
      ["Contract:Team.inviteMember.requires.passingPredicate", true, "predicate"],
      ["Contract:Team.inviteMember.requires.failingGuard", false, "guard"],
    ]);
    expect(guardCalls).toBe(1);
    expect(r.firstFailure).toEqual({
      contract: "Contract:Team.inviteMember.requires.failingExpr",
      message: "Contract:Team.inviteMember.requires.failingExpr failed: input.role == \"owner\"",
      evaluated: { "": { lhs: "member", rhs: "owner" } },
    });
    expect(r.dbCalls).toBe(1);
  });

  it("guards get the plain client even when predicates use the transaction client", async () => {
    const plain = createFakePrisma(seedTables());
    const tx = createFakePrisma(seedTables());
    let guardClient: unknown;
    const decl = inviteMember({
      requires: {
        p: db.exists("team", { id: "t1" }),
        g: async ({ prisma }: { prisma: unknown }) => {
          guardClient = prisma;
          return true;
        },
      },
    });
    const r = await evaluatePhase("requires", records(decl).filter((c) => c.phase === "requires"), { input: {} }, { prisma: tx, guardPrisma: plain });
    expect(r.firstFailure).toBeNull();
    expect(guardClient).toBe(plain);
    expect(tx.$calls.length).toBe(1);
    expect(plain.$calls.length).toBe(0);
  });

  it("predicate records carry undefinedRefs and the guard message names the throw", async () => {
    const prisma = createFakePrisma(seedTables());
    const notMember = records().find((c) => c.clause === "notAlreadyMember")!;
    const r = await evaluateContract(notMember, "requires", { input: { teamId: "t1" } }, { prisma });
    expect(r.ok).toBe(false);
    expect(r.record).toMatchObject({ phase: "requires", ok: false, tier: "predicate", undefinedRefs: ["input.email"] });
    expect(r.message).toMatch(/undefined refs: input.email/);
    const guard = records(
      inviteMember({
        requires: {
          g: async () => {
            throw new Error("allowlist down");
          },
        },
      }),
    )[0]!;
    const g = await evaluateContract(guard, "requires", {}, {});
    expect(g.record).toMatchObject({ tier: "guard", ok: false });
    expect(g.message).toBe("Contract:Team.inviteMember.requires.g failed: guard threw: allowlist down");
  });

  it("evaluateInvariants evaluates entity invariants against a row", async () => {
    const invariants = averriMeta(Invitation).contracts;
    expect((await evaluateInvariants(invariants, { status: "pending", acceptedAt: null })).firstFailure).toBeNull();
    expect((await evaluateInvariants(invariants, { status: "accepted", acceptedAt: new Date() })).firstFailure).toBeNull();
    const bad = await evaluateInvariants(invariants, { status: "pending", acceptedAt: new Date() });
    expect(bad.firstFailure?.contract).toBe("Contract:Invitation.invariant.pendingHasNoAcceptedAt");
    expect(bad.records[0]?.phase).toBe("ensures");
  });
});

describe("evaluatePolicy", () => {
  it("decides allow/deny from the policy AST against { input, actor }", async () => {
    const prisma = createFakePrisma(seedTables());
    const admin = await evaluatePolicy(OwnerOrAdmin, { input: { teamId: "t1" }, actor: actors.admin }, { prisma });
    expect(admin.allow).toBe(true);
    expect(admin.contract).toBe("Contract:Team.OwnerOrAdmin.allow");
    expect(admin.tier).toBe("predicate");
    const member = await evaluatePolicy(OwnerOrAdmin, { input: { teamId: "t1" }, actor: actors.member }, { prisma });
    expect(member.allow).toBe(false);
    expect(member.evaluated).toEqual({ "": { lhs: 0, rhs: "count > 0" } });
    const other = await evaluatePolicy(OwnerOrAdmin, { input: { teamId: "t1" }, actor: actors.other }, { prisma });
    expect(other.allow).toBe(false);
  });

  it("an anonymous actor given directly to evaluatePolicy is denied fail-closed with undefinedRefs and no call", async () => {
    const prisma = createFakePrisma(seedTables());
    const r = await evaluatePolicy(OwnerOrAdmin, { input: { teamId: "t1" }, actor: null }, { prisma });
    expect(r.allow).toBe(false);
    expect(r.undefinedRefs).toEqual(["actor.id"]);
    expect(r.dbCalls).toBe(0);
    expect(prisma.$calls).toEqual([]);
  });

  it("a negated db predicate in a policy never allows an actor without an id or a request while the DB is down", async () => {
    const notBanned = policy("Team.NotBanned", { allow: e.not(db.exists("membership", { userId: e.actor("id"), role: "banned" })) });
    const healthy = createFakePrisma(seedTables());
    expect((await evaluatePolicy(notBanned, { input: {}, actor: actors.admin }, { prisma: healthy })).allow).toBe(true);
    const noId = await evaluatePolicy(notBanned, { input: {}, actor: {} as never }, { prisma: healthy });
    expect(noId.allow).toBe(false);
    expect(noId.undefinedRefs).toEqual(["actor.id"]);
    const down = createFakePrisma(seedTables(), { failCount: ["membership"] });
    const outage = await evaluatePolicy(notBanned, { input: {}, actor: actors.admin }, { prisma: down });
    expect(outage.allow).toBe(false);
    expect(outage.message).toMatch(/evaluation errors: .*count failed/);
  });

  it("supports guard policies and expression policies", async () => {
    const guardPolicy = policy("Team.Guarded", { allow: async ({ actor }) => actor.role === "admin" });
    expect((await evaluatePolicy(guardPolicy, { input: {}, actor: actors.admin })).allow).toBe(true);
    expect((await evaluatePolicy(guardPolicy, { input: {}, actor: actors.member })).allow).toBe(false);
    const exprPolicy = policy("Team.SameOrg", { allow: e.eq("actor.orgId", e.input("orgId")) });
    const r = await evaluatePolicy(exprPolicy, { input: { orgId: "o1" }, actor: actors.admin });
    expect(r.allow).toBe(true);
    expect(r.tier).toBe("expr");
  });
});
