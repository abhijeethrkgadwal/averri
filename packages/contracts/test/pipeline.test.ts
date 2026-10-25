/**
 * The declared-mode pipeline (SPEC-DECLARATIONS §5.3): every phase failure status, the transaction
 * boundary (rollback vs `committed: true`), emit after commit (D-12), invariants, sampling, traces.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { action, defineConfig, e, query, type ActionContext, type Actor } from "@averri/core";
import { AverriRuntimeError, createRuntime, handle, invoke, memoryTraceRecorder, type Row } from "../src/index.js";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import {
  Invitation,
  MemberInvited,
  OwnerOrAdmin,
  actors,
  config,
  inviteInput,
  inviteMember,
  published,
  resetBus,
  seedTables,
  setPublishError,
  validInput,
} from "./helpers/fixtures.js";

let prisma: FakePrisma;
beforeEach(() => {
  prisma = createFakePrisma(seedTables());
  resetBus();
});

const base = () => ({ prisma, config, recorder: null, declarations: [Invitation] });
const phasesOf = (r: { trace: { phases: Array<{ phase: string }> } }) => r.trace.phases.map((p) => p.phase);

describe("validate", () => {
  it("400 ValidationFailed before anything touches the database", async () => {
    const r = await invoke(inviteMember(), { ...base(), input: { teamId: "t1", email: "nope", role: "member" }, actor: actors.admin });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "ValidationFailed" });
    expect((r.body as { message: string }).message).toMatch(/email/);
    expect(r.trace.phases).toEqual([{ phase: "validate", ok: false, issues: expect.any(Array) }]);
    expect(r.trace.outcome).toEqual({ ok: false, phase: "validate", message: expect.any(String), committed: false });
    expect(prisma.$calls).toEqual([]);
    expect(prisma.$txCount).toBe(0);
  });
});

describe("authorize", () => {
  it("(a) 401 Unauthenticated for an anonymous actor: the policy is never evaluated", async () => {
    const r = await invoke(inviteMember(), { ...base(), input: validInput, actor: null });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "Unauthenticated", message: expect.any(String) });
    expect(r.trace.phases).toEqual([
      { phase: "validate", ok: true },
      { phase: "authorize", ok: false, policy: "Policy:Team.OwnerOrAdmin", decision: "unauthenticated", observed: false },
    ]);
    expect(prisma.$calls).toEqual([]);
    expect(r.trace.actor).toBeNull();
  });

  it("403 Forbidden on policy denial with the Policy id and evaluated operands", async () => {
    const r = await invoke(inviteMember(), { ...base(), input: validInput, actor: actors.member });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: "Forbidden",
      contract: "Policy:Team.OwnerOrAdmin",
      evaluated: { "": { lhs: 0, rhs: "count > 0" } },
      message: expect.stringContaining("Policy:Team.OwnerOrAdmin denied"),
    });
    expect(r.trace.phases[1]).toEqual({ phase: "authorize", ok: false, policy: "Policy:Team.OwnerOrAdmin", decision: "deny", observed: false });
    expect(prisma.$calls).toEqual([{ model: "membership", op: "count", args: expect.anything(), tx: false }]);
    expect(prisma.$txCount).toBe(0);
    expect(r.trace.outcome).toMatchObject({ ok: false, phase: "authorize", contract: "Policy:Team.OwnerOrAdmin", committed: false });
  });

  it("public actions skip the policy and accept a null actor", async () => {
    const decl = inviteMember({ public: true, ensures: {}, run: async ({ input, actor }) => ({ email: input.email, actor }) });
    const r = await invoke(decl, { ...base(), input: validInput, actor: null });
    expect(r.body).toEqual({ email: "new@acme.io", actor: null });
    expect(r.status).toBe(200);
    expect(r.trace.phases[1]).toEqual({ phase: "authorize", ok: true, policy: null, decision: "public", observed: false });
  });
});

describe("requires", () => {
  it("412 PreconditionFailed: all clauses evaluated, first failure reported, run never called", async () => {
    let ran = false;
    let guardClient: unknown;
    const decl = inviteMember({
      requires: {
        notAlreadyMember: inviteMember().options.requires!.notAlreadyMember!,
        emailDomainAllowed: async ({ prisma: p }: { prisma: unknown }) => {
          guardClient = p;
          return true;
        },
      },
      run: async (ctx) => {
        ran = true;
        return ctx.input;
      },
    });
    const r = await invoke(decl, { ...base(), input: { ...validInput, email: "member@acme.io" }, actor: actors.admin });
    expect(r.status).toBe(412);
    expect(r.body).toEqual({
      error: "PreconditionFailed",
      contract: "Contract:Team.inviteMember.requires.notAlreadyMember",
      evaluated: { "": { lhs: 1, rhs: "count == 0" } },
      message: expect.stringContaining("notAlreadyMember failed"),
    });
    expect(ran).toBe(false);
    expect(guardClient).toBe(prisma);
    const requires = r.trace.phases.filter((p) => p.phase === "requires");
    expect(requires.map((p) => [(p as { contract: string }).contract, p.ok])).toEqual([
      ["Contract:Team.inviteMember.requires.notAlreadyMember", false],
      ["Contract:Team.inviteMember.requires.emailDomainAllowed", true],
    ]);
    expect(prisma.$txCount).toBe(1);
    const predicateCall = prisma.$calls.find((c) => c.model === "membership" && c.tx);
    expect(predicateCall?.args).toEqual({ where: { teamId: "t1", user: { email: "member@acme.io" } } });
    expect(r.trace.outcome).toMatchObject({ ok: false, phase: "requires", committed: false });
  });

  it("a failing guard yields 412 without `evaluated`", async () => {
    const r = await invoke(inviteMember(), { ...base(), input: { ...validInput, email: "new@other.com" }, actor: actors.admin });
    expect(r.status).toBe(412);
    expect(r.body).toEqual({ error: "PreconditionFailed", contract: "Contract:Team.inviteMember.requires.emailDomainAllowed", message: expect.any(String) });
  });

  it("412 with Contract:<action>.requires.$subject when subject.where selects more than one row", async () => {
    prisma.$tables.invitation!.push({ id: "inv2", teamId: "t1", email: "two@acme.io", status: "pending", acceptedAt: null });
    const decl = inviteMember({ subject: { entity: Invitation, where: { teamId: e.input("teamId") } }, requires: {}, ensures: {} });
    const r = await invoke(decl, { ...base(), input: validInput, actor: actors.admin });
    expect(r.status).toBe(412);
    expect(r.body).toMatchObject({ error: "PreconditionFailed", contract: "Contract:Team.inviteMember.requires.$subject" });
    expect(r.trace.phases.find((p) => p.phase === "requires")).toMatchObject({ contract: "Contract:Team.inviteMember.requires.$subject", ok: false, tier: "predicate" });
  });

  it("subject: self before run, old snapshot, self reloaded for ensures; 0 rows makes self.* undefined", async () => {
    const decl = inviteMember({
      subject: { entity: Invitation, where: { email: e.input("email") } },
      requires: { isPending: e.eq("self.status", "pending") },
      ensures: { resent: e.and(e.eq("old.status", "pending"), e.eq("self.status", "resent"), e.ne("self.status", e.old("status"))) },
      run: async ({ tx, self }) => {
        expect(self).toMatchObject({ id: "inv_old", status: "pending" });
        return (tx as unknown as FakePrisma).invitation!.update({ where: { id: "inv_old" }, data: { status: "resent" } });
      },
    });
    const ok = await invoke(decl, { ...base(), input: { ...validInput, email: "pending@acme.io" }, actor: actors.admin });
    expect(ok.status).toBe(200);
    // ensures.resent, then the subject entity's invariant on the reloaded row, then the output entity's invariant on the result
    expect(ok.trace.phases.filter((p) => p.phase === "ensures").map((p) => [(p as { contract: string }).contract, p.ok])).toEqual([
      ["Contract:Team.inviteMember.ensures.resent", true],
      ["Contract:Invitation.invariant.pendingHasNoAcceptedAt", true],
      ["Contract:Invitation.invariant.pendingHasNoAcceptedAt", true],
    ]);
    const missing = await invoke(decl, { ...base(), input: { ...validInput, email: "ghost@acme.io" }, actor: actors.admin });
    expect(missing.status).toBe(412);
    expect(missing.trace.phases.find((p) => p.phase === "requires")).toMatchObject({ ok: false, undefinedRefs: ["self.status"] });
  });

  it("includes relations used by owned-list ops when loading the subject", async () => {
    prisma.$tables.invitation![0]!.notes = [{ kind: "a" }, { kind: "b" }];
    const decl = inviteMember({
      subject: { entity: Invitation, where: { email: e.input("email") } },
      requires: { hasNote: e.exists("self.notes", e.eq("kind", "a")), two: e.eq(e.count("self.notes"), 2) },
      ensures: {},
      run: async () => ({ status: "pending", acceptedAt: null }),
    });
    const r = await invoke(decl, { ...base(), input: { ...validInput, email: "pending@acme.io" }, actor: actors.admin });
    expect(r.status).toBe(200);
    const load = prisma.$calls.find((c) => c.model === "invitation" && c.op === "findMany");
    expect(load?.args).toEqual({ where: { email: "pending@acme.io" }, take: 2, include: { notes: true } });
  });
});

describe("run and ensures", () => {
  it("500 HandlerError on throw, transaction rolled back", async () => {
    const decl = inviteMember({
      run: async ({ tx }) => {
        await (tx as unknown as FakePrisma).invitation!.create({ data: { email: "x@acme.io" } });
        throw new Error("boom");
      },
    });
    const r = await invoke(decl, { ...base(), input: validInput, actor: actors.admin });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "HandlerError", message: "run threw: boom" });
    expect(prisma.$tables.invitation!.length).toBe(1);
    expect(r.trace.phases.find((p) => p.phase === "run")).toEqual({ phase: "run", ok: false, durationMs: expect.any(Number), dbCalls: 1, error: "boom" });
    expect(r.trace.outcome).toEqual({ ok: false, phase: "run", message: "run threw: boom", committed: false });
    expect(published).toEqual([]);
  });

  it("500 PostconditionFailed inside a transaction rolls back and does not emit", async () => {
    const decl = inviteMember({ ensures: { accepted: e.eq("result.status", "accepted") } });
    const r = await invoke(decl, { ...base(), input: validInput, actor: actors.admin });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({
      error: "PostconditionFailed",
      contract: "Contract:Team.inviteMember.ensures.accepted",
      evaluated: { "": { lhs: "pending", rhs: "accepted" } },
      message: expect.stringContaining("ensures.accepted failed"),
    });
    expect((r.body as { committed?: boolean }).committed).toBeUndefined();
    expect(prisma.$tables.invitation!.length).toBe(1);
    expect(published).toEqual([]);
    expect(phasesOf(r)).toEqual(["validate", "authorize", "requires", "requires", "run", "ensures"]);
    expect(r.trace.outcome).toMatchObject({ ok: false, phase: "ensures", contract: "Contract:Team.inviteMember.ensures.accepted", committed: false });
  });

  it("transaction: false → PostconditionFailed carries committed: true in the body and the trace", async () => {
    const decl = inviteMember({ transaction: false, ensures: { accepted: e.eq("result.status", "accepted") } });
    const r = await invoke(decl, { ...base(), input: validInput, actor: actors.admin });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: "PostconditionFailed", committed: true });
    expect(prisma.$tables.invitation!.length).toBe(2);
    expect(prisma.$txCount).toBe(0);
    expect(r.trace.outcome).toMatchObject({ ok: false, phase: "ensures", committed: true });
    expect(prisma.$calls.every((c) => !c.tx)).toBe(true);
  });

  it("transaction: false → a HandlerError is committed: true in the trace only", async () => {
    const decl = inviteMember({
      transaction: false,
      run: async () => {
        throw new Error("late");
      },
    });
    const r = await invoke(decl, { ...base(), input: validInput, actor: actors.admin });
    expect(r.body).toEqual({ error: "HandlerError", message: "run threw: late" });
    expect(r.trace.outcome).toMatchObject({ phase: "run", committed: true });
  });

  it("success: 200, serialised body, events published after commit, full trace", async () => {
    const recorder = memoryTraceRecorder();
    const r = await invoke(inviteMember(), { ...base(), recorder, input: validInput, actor: actors.admin, test: { file: "t.test.ts", title: "x" } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: expect.any(String),
      teamId: "t1",
      email: "new@acme.io",
      role: "member",
      invitedBy: "u_admin",
      status: "pending",
      acceptedAt: null,
      createdAt: "2026-10-24T10:00:00.000Z",
    });
    expect(published).toEqual([{ name: "averri/MemberInvited", payload: { invitationId: expect.any(String), teamId: "t1", email: "new@acme.io" } }]);
    expect(phasesOf(r)).toEqual(["validate", "authorize", "requires", "requires", "run", "ensures", "ensures", "ensures", "emit"]);
    expect(r.trace.phases.find((p) => p.phase === "run")).toMatchObject({ ok: true, dbCalls: 1 });
    const ensures = r.trace.phases.filter((p) => p.phase === "ensures") as Array<{ contract: string; ok: boolean }>;
    expect(ensures.map((p) => p.contract)).toEqual([
      "Contract:Team.inviteMember.ensures.pendingForEmail",
      "Contract:Team.inviteMember.ensures.eventEmitted",
      "Contract:Invitation.invariant.pendingHasNoAcceptedAt",
    ]);
    expect(ensures.every((p) => p.ok)).toBe(true);
    expect(r.trace.phases.at(-1)).toEqual({ phase: "emit", ok: true, events: [{ event: "Event:MemberInvited", payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
    expect(r.trace).toMatchObject({ action: "Action:Team.inviteMember", mode: "declared", actor: { id: "u_admin", summary: "admin#u_admin" }, outcome: { ok: true }, test: { file: "t.test.ts", title: "x" } });
    expect(r.trace.traceId).toMatch(/[0-9a-f-]{36}/);
    expect(r.trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(recorder.traces).toEqual([r.trace]);
    // guards ran with the plain client, predicates inside the transaction
    expect(prisma.$calls.filter((c) => c.op === "count").map((c) => c.tx)).toEqual([false, true]);
  });

  it("emit failure after commit is trace-only (D-12): the response stays 2xx", async () => {
    setPublishError(new Error("bus down"));
    const r = await invoke(inviteMember(), { ...base(), input: validInput, actor: actors.admin });
    expect(r.status).toBe(200);
    expect((r.body as Row).email).toBe("new@acme.io");
    expect(prisma.$tables.invitation!.length).toBe(2);
    expect(r.trace.phases.at(-1)).toMatchObject({ phase: "emit", ok: false, error: "bus down" });
    expect(r.trace.outcome).toEqual({ ok: false, phase: "emit", message: "bus down", committed: true });
  });

  it("emitting without a configured emitter is a trace-only failure", async () => {
    const noEmitter = defineConfig({ entryPoints: ["src/app.ts"], actors: config.actors });
    const r = await invoke(inviteMember(), { ...base(), config: noEmitter, input: validInput, actor: actors.admin });
    expect(r.status).toBe(200);
    expect(r.trace.phases.at(-1)).toMatchObject({ phase: "emit", ok: false, error: expect.stringContaining("no emitter configured") });
  });

  it("emit() rejects non-event arguments (HandlerError)", async () => {
    const decl = inviteMember({
      run: async ({ emit }) => {
        (emit as unknown as (x: unknown, p: unknown) => void)({ kind: "event" }, {});
        return {};
      },
    });
    const r = await invoke(decl, { ...base(), input: validInput, actor: actors.admin });
    expect(r.status).toBe(500);
    expect((r.body as { message: string }).message).toMatch(/event\(\) declaration/);
  });
});

describe("invariants", () => {
  it("subject entity invariants are evaluated on the reloaded row and fail with 500 PostconditionFailed", async () => {
    const decl = inviteMember({
      subject: { entity: Invitation, where: { email: e.input("email") } },
      requires: {},
      ensures: {},
      run: async ({ tx }) => (tx as unknown as FakePrisma).invitation!.update({ where: { email: "pending@acme.io" }, data: { acceptedAt: new Date() } }),
    });
    const r = await invoke(decl, { ...base(), input: { ...validInput, email: "pending@acme.io" }, actor: actors.admin });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: "PostconditionFailed", contract: "Contract:Invitation.invariant.pendingHasNoAcceptedAt" });
    expect(prisma.$tables.invitation![0]!.acceptedAt).toBeNull();
  });

  it("output entity by NAME resolves through `declarations`; without them nothing is checked", async () => {
    const decl = inviteMember({ output: "Invitation", ensures: {}, run: async () => ({ status: "pending", acceptedAt: new Date() }) });
    const checked = await invoke(decl, { ...base(), input: validInput, actor: actors.admin });
    expect(checked.status).toBe(500);
    expect(checked.body).toMatchObject({ contract: "Contract:Invitation.invariant.pendingHasNoAcceptedAt" });
    const unchecked = await invoke(decl, { ...base(), declarations: [], input: validInput, actor: actors.admin });
    expect(unchecked.status).toBe(200);
  });
});

describe("sampling, transaction options, recorder", () => {
  const violating = () => inviteMember({ ensures: { accepted: e.eq("result.status", "accepted") } });

  it("production sampling: ensures/invariants off at 0, on when random() < rate; requires always on", async () => {
    const off = await invoke(violating(), { ...base(), production: true, input: validInput, actor: actors.admin });
    expect(off.status).toBe(200);
    expect(off.trace.phases.some((p) => p.phase === "ensures")).toBe(false);
    const sampled = defineConfig({ entryPoints: ["src/app.ts"], actors: config.actors, sampling: { ensures: 0.5, invariants: 0 } });
    const on = await invoke(violating(), { ...base(), config: sampled, production: true, random: () => 0.1, input: validInput, actor: actors.admin });
    expect(on.status).toBe(500);
    const skipped = await invoke(violating(), { ...base(), config: sampled, production: true, random: () => 0.9, input: validInput, actor: actors.admin });
    expect(skipped.status).toBe(200);
    const stillRequires = await invoke(inviteMember(), { ...base(), production: true, input: { ...validInput, email: "member@acme.io" }, actor: actors.admin });
    expect(stillRequires.status).toBe(412);
  });

  it("passes transaction { timeout, maxWait } through to $transaction", async () => {
    await invoke(inviteMember({ transaction: { timeout: 1000, maxWait: 500 } }), { ...base(), input: validInput, actor: actors.admin });
    expect(prisma.$txOptions).toEqual([{ timeout: 1000, maxWait: 500 }]);
    await invoke(inviteMember(), { ...base(), input: validInput, actor: actors.admin });
    expect(prisma.$txOptions[1]).toBeUndefined();
  });

  it("a $transaction failure before run is a 500 HandlerError", async () => {
    const failing = createFakePrisma(seedTables(), { transactionError: new Error("pool exhausted") });
    const r = await invoke(inviteMember(), { ...base(), prisma: failing, input: validInput, actor: actors.admin });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "HandlerError", message: "pool exhausted" });
  });

  it("a client without $transaction is a configuration error when a transaction is declared", async () => {
    const bare = { invitation: prisma.invitation } as object;
    await expect(invoke(inviteMember(), { ...base(), prisma: bare, input: validInput, actor: actors.admin })).rejects.toMatchObject({ code: "no-transaction" });
    const r = await invoke(inviteMember({ transaction: false, requires: {}, ensures: {} }), { ...base(), prisma: { ...seedClient(), $transaction: undefined } as object, input: validInput, actor: actors.admin });
    expect(r.status).toBe(200);
  });

  it("records the trace with the Vitest test info by default", async () => {
    const recorder = memoryTraceRecorder();
    await invoke(inviteMember(), { ...base(), recorder, input: validInput, actor: actors.admin });
    expect(recorder.traces[0]?.test?.title).toContain("records the trace with the Vitest test info");
    expect(recorder.traces[0]?.test?.file).toMatch(/pipeline\.test\.ts$/);
  });
});

function seedClient(): Record<string, unknown> {
  const client = createFakePrisma(seedTables());
  return { invitation: client.invitation, membership: client.membership, team: client.team };
}

describe("queries, handle and createRuntime", () => {
  const listMembers = query("Team.listMembers", {
    input: z.object({ teamId: z.string() }),
    policy: OwnerOrAdmin,
    run: async ({ input, db }) => (db as unknown as FakePrisma).membership!.findMany({ where: { teamId: input.teamId } }),
  });

  it("queries run validate → authorize → run on the plain client with no contracts or emit phase", async () => {
    const r = await invoke(listMembers, { ...base(), input: { teamId: "t1" }, actor: actors.admin });
    expect(r.status).toBe(200);
    expect((r.body as Row[]).length).toBe(2);
    expect(phasesOf(r)).toEqual(["validate", "authorize", "run"]);
    expect(r.trace.action).toBe("Query:Team.listMembers");
    expect(r.trace.phases[2]).toMatchObject({ phase: "run", ok: true, dbCalls: 1 });
    expect(prisma.$txCount).toBe(0);
    expect((await invoke(listMembers, { ...base(), input: { teamId: "t1" }, actor: actors.member })).status).toBe(403);
  });

  it("handle() and createRuntime() bind the runtime once", async () => {
    const fn = handle(inviteMember(), base());
    expect((await fn(validInput, actors.admin)).status).toBe(200);
    const runtime = createRuntime(base());
    expect((await runtime.handle(inviteMember())(validInput, actors.member)).status).toBe(403);
    expect((await runtime.invoke(inviteMember(), { input: validInput, actor: null })).status).toBe(401);
  });

  it("observe-mode declarations cannot be invoked", async () => {
    const observed = action("Team.observed", { route: { method: "POST", path: "/x" }, input: inviteInput, policy: OwnerOrAdmin, effects: [] });
    await expect(invoke(observed, { ...base(), input: validInput, actor: actors.admin })).rejects.toBeInstanceOf(AverriRuntimeError);
    expect(() => handle(observed, base())).toThrow(/observe-mode/);
  });

  it("typed run context: actor is non-null under a policy and tx/self/emit are present", async () => {
    let seen: ActionContext<typeof inviteInput, Actor> | null = null;
    const decl = inviteMember({
      run: async (ctx) => {
        seen = ctx;
        return { ok: true };
      },
    });
    await invoke(decl, { ...base(), input: validInput, actor: actors.admin });
    expect(seen).not.toBeNull();
    expect(seen!.actor.id).toBe("u_admin");
    expect(seen!.self).toBeNull();
    expect(typeof seen!.emit).toBe("function");
    expect(typeof (seen!.tx as unknown as FakePrisma).invitation!.create).toBe("function");
    expect(MemberInvited.id).toBe("Event:MemberInvited");
  });
});
