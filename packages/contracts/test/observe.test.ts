/**
 * Observe mode (SPEC-DECLARATIONS §6, D-6): the route matcher, the fetch-boundary wrapper over a
 * Hono app and over an Express app (ephemeral server), the emitter spy, DB snapshots and traces.
 */
import express from "express";
import { Hono, type Context } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { action, db, e, query, type Actor, type ObserveHandle } from "@averri/core";
import { AverriRuntimeError, compileRoute, findRoute, installEmitterSpy, matchRoute, memoryTraceRecorder, normaliseRoutePath, observe, requestFor } from "../src/index.js";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { Invitation, MemberInvited, OwnerOrAdmin, bus, config, inviteInput, inviteRoute, resetBus, seedTables } from "./helpers/fixtures.js";

describe("route matcher", () => {
  it("normalises per SPEC-IR §4.1", () => {
    expect(normaliseRoutePath("/teams//:id{[0-9]+}/")).toBe("/teams/:id");
    expect(normaliseRoutePath("/a/:b?")).toBe("/a/:b");
    expect(normaliseRoutePath("/")).toBe("/");
    expect(normaliseRoutePath("x")).toBe("/x");
    expect(normaliseRoutePath("/a/b?x=1")).toBe("/a/b");
  });

  it("matches methods, static and param segments; wildcards never match", () => {
    const route = compileRoute({ method: "POST", path: "/teams/:teamId/invitations" });
    expect(matchRoute(route, "post", "/teams/t1/invitations/")).toEqual({ teamId: "t1" });
    expect(matchRoute(route, "POST", "/teams/a%40b/invitations")).toEqual({ teamId: "a@b" });
    expect(matchRoute(route, "GET", "/teams/t1/invitations")).toBeNull();
    expect(matchRoute(route, "POST", "/teams/t1")).toBeNull();
    expect(matchRoute(route, "POST", "/teams//invitations")).toBeNull();
    expect(matchRoute(compileRoute({ method: "GET", path: "/" }), "GET", "/")).toEqual({});
    expect(matchRoute(compileRoute({ method: "GET", path: "/files/*" }), "GET", "/files/a")).toBeNull();
    expect(matchRoute(compileRoute({ method: "GET", path: "/files/:rest*" }), "GET", "/files/a")).toBeNull();
    const routes = [{ route: compileRoute({ method: "GET", path: "/a/:x" }), name: 1 }, { route: compileRoute({ method: "GET", path: "/a/b" }), name: 2 }];
    expect(findRoute(routes, "GET", "/a/b")?.entry.name).toBe(1);
    expect(findRoute(routes, "GET", "/z")).toBeNull();
  });
});

describe("emitter spy", () => {
  it("records names/payloads, strips the prefix, calls through and restores", async () => {
    const original = bus.send;
    const spy = installEmitterSpy({ target: bus, method: "send" }, "averri/");
    await bus.send({ name: "averri/MemberInvited", data: { a: 1 } });
    await bus.send([{ name: "other/Thing", data: {} }, { name: "averri/MemberInvited" }]);
    (bus.send as unknown as (name: string, payload: unknown) => unknown)("averri/ByName", { b: 2 });
    expect(spy.emitted).toEqual(["Event:MemberInvited", "Event:other/Thing", "Event:MemberInvited", "Event:ByName"]);
    expect(spy.calls[0]).toEqual({ name: "averri/MemberInvited", payload: { a: 1 } });
    expect(bus.sent.length).toBe(3);
    spy.restore();
    expect(bus.send).toBe(original);
    resetBus();
  });
});

// ---------------------------------------------------------------------------
// Observe-mode declarations (no run) for the worked example
// ---------------------------------------------------------------------------

const InviteMember = action("Team.inviteMember", {
  intent: "An owner or admin invites a person by email.",
  route: inviteRoute,
  input: inviteInput,
  output: Invitation,
  policy: OwnerOrAdmin,
  requires: { notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }) },
  ensures: {
    pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
    eventEmitted: e.emitted(MemberInvited, 1),
  },
  effects: ["db:write", "event:emit"],
});

const ResendInvite = action("Team.resendInvite", {
  route: { method: "POST", path: "/invitations/:email/resend" },
  input: z.object({ email: z.string() }),
  public: true,
  subject: { entity: Invitation, where: { email: e.input("email") } },
  requires: { isPending: e.eq("self.status", "pending") },
  ensures: { resent: e.and(e.eq("old.status", "pending"), e.eq("self.status", "resent")) },
  effects: ["db:write"],
});

const ListMembers = query("Team.listMembers", {
  route: { method: "GET", path: "/teams/:teamId/members" },
  input: z.object({ teamId: z.string() }),
  policy: OwnerOrAdmin,
});

const declarations = [Invitation, OwnerOrAdmin, MemberInvited, InviteMember, ResendInvite, ListMembers];

function actorFromHeader(header: string | undefined): Actor | null {
  if (header === "Bearer admin") return { id: "u_admin", orgId: "o1", role: "admin" };
  if (header === "Bearer member") return { id: "u_member", orgId: "o1", role: "member" };
  if (header === "Bearer other") return { id: "u_other", orgId: "o2", role: "admin" };
  return null;
}

/** The "existing" Hono app with inline handlers; test knobs are headers so bodies stay schema-valid. */
function buildHonoApp(prisma: FakePrisma): Hono {
  type Env = { Variables: { user: Actor | null } };
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("user", actorFromHeader(c.req.header("authorization")));
    await next();
  });
  app.get("/health", (c) => c.text("ok"));
  app.get("/teams/:teamId/members", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (user.role !== "admin") return c.json({ error: "forbidden" }, 403);
    return c.json(await prisma.membership!.findMany({ where: { teamId: c.req.param("teamId") } }));
  });
  app.post("/teams/:teamId/invitations", async (c: Context<Env>) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const teamId = c.req.param("teamId");
    const body = (await c.req.json()) as { email?: string; role?: string };
    if (!body.email) return c.json({ error: "email required" }, 400);
    const allowed = await prisma.membership!.count({ where: { teamId, userId: user.id, role: { in: ["owner", "admin"] } } });
    if (allowed === 0 && !c.req.header("x-test-bypass")) return c.json({ error: "forbidden" }, 403);
    if ((await prisma.membership!.count({ where: { teamId, user: { email: body.email } } })) > 0) return c.json({ error: "already a member" }, 409);
    const inv = await prisma.invitation!.create({
      data: { teamId, email: body.email, role: body.role ?? "member", status: "pending", acceptedAt: c.req.header("x-test-break-invariant") ? new Date("2026-10-24T00:00:00Z") : null },
    });
    if (!c.req.header("x-test-skip-emit")) await bus.send({ name: "averri/MemberInvited", data: { invitationId: inv.id, teamId, email: inv.email } });
    return c.json(inv, 201);
  });
  app.post("/invitations/:email/resend", async (c) => {
    const row = await prisma.invitation!.update({ where: { email: c.req.param("email") }, data: { status: "resent" } });
    return c.json(row);
  });
  return app as unknown as Hono;
}

describe("observe() over a Hono app", () => {
  let prisma: FakePrisma;
  let handle: ObserveHandle;
  let recorder = memoryTraceRecorder();

  beforeEach(async () => {
    prisma = createFakePrisma(seedTables());
    recorder = memoryTraceRecorder();
    resetBus();
    handle = await observe(buildHonoApp(prisma), { declarations, config, prisma, recorder });
  });
  afterEach(async () => {
    await handle.close();
  });

  it("evaluates every phase around the real handler and records one trace", async () => {
    const originalSend = bus.send;
    const res = await handle.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "new@acme.io", status: "pending" });
    const trace = res.trace!;
    expect(trace).toMatchObject({ action: "Action:Team.inviteMember", mode: "observe", actor: { id: "u_admin", summary: "admin#u_admin" }, outcome: { ok: true } });
    expect(trace.phases).toEqual([
      { phase: "validate", ok: true },
      { phase: "authorize", ok: true, policy: "Policy:Team.OwnerOrAdmin", decision: "allow", observed: false },
      expect.objectContaining({ phase: "requires", ok: true, contract: "Contract:Team.inviteMember.requires.notAlreadyMember", tier: "predicate" }),
      { phase: "authorize", ok: true, policy: "Policy:Team.OwnerOrAdmin", decision: "allow", observed: true },
      { phase: "run", ok: true, durationMs: expect.any(Number), dbCalls: 0 },
      { phase: "emit", ok: true, events: [{ event: "Event:MemberInvited", payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/) }] },
      expect.objectContaining({ phase: "ensures", ok: true, contract: "Contract:Team.inviteMember.ensures.pendingForEmail" }),
      expect.objectContaining({ phase: "ensures", ok: true, contract: "Contract:Team.inviteMember.ensures.eventEmitted", evaluated: { "": { lhs: 1, rhs: 1 } } }),
    ]);
    expect(trace.request).toEqual({
      method: "POST",
      path: "/teams/t1/invitations",
      body: { email: "new@acme.io", role: "member" },
      headers: { authorization: "[redacted]", "content-type": "application/json" },
    });
    expect(trace.test?.title).toContain("evaluates every phase around the real handler");
    expect(recorder.traces).toEqual([trace]);
    expect(bus.send).toBe(originalSend);
    expect(bus.sent.length).toBe(1);
  });

  it("records the app's own 403/401 as the observed decision and agrees with the policy", async () => {
    const member = await handle.request("member", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" } });
    expect(member.status).toBe(403);
    const auth = member.trace!.phases.filter((p) => p.phase === "authorize");
    expect(auth).toEqual([
      { phase: "authorize", ok: false, policy: "Policy:Team.OwnerOrAdmin", decision: "deny", observed: false },
      { phase: "authorize", ok: true, policy: "Policy:Team.OwnerOrAdmin", decision: "deny", observed: true },
    ]);
    expect(member.trace!.phases.some((p) => p.phase === "ensures")).toBe(false);
    expect(member.trace!.outcome).toEqual({ ok: true });
    const anon = await handle.request("anonymous", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" } });
    expect(anon.status).toBe(401);
    expect(anon.trace!.phases.filter((p) => p.phase === "authorize").map((p) => (p as { decision: string }).decision)).toEqual(["unauthenticated", "unauthenticated"]);
    expect(anon.trace!.actor).toBeNull();
    expect(prisma.$calls.filter((c) => c.op === "count").length).toBeGreaterThan(0);
  });

  it("flags a disagreement between the app's decision and the declared policy", async () => {
    const res = await handle.request("member", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" }, headers: { "x-test-bypass": "1" } });
    expect(res.status).toBe(201);
    const observed = res.trace!.phases.find((p) => p.phase === "authorize" && (p as { observed: boolean }).observed);
    expect(observed).toMatchObject({ ok: false, decision: "allow" });
    expect(res.trace!.outcome).toMatchObject({ ok: false, phase: "authorize", committed: false });
  });

  it("a missing emission fails `ensures.eventEmitted` with committed: true", async () => {
    const res = await handle.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" }, headers: { "x-test-skip-emit": "1" } });
    expect(res.status).toBe(201);
    expect(res.trace!.outcome).toEqual({ ok: false, phase: "ensures", contract: "Contract:Team.inviteMember.ensures.eventEmitted", message: expect.stringContaining("evaluated to false"), committed: true });
  });

  it("re-reads entities with invariants and reports a violated invariant on the changed row", async () => {
    const res = await handle.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" }, headers: { "x-test-break-invariant": "1" } });
    expect(res.status).toBe(201);
    const invariant = res.trace!.phases.find((p) => (p as { contract?: string }).contract === "Contract:Invitation.invariant.pendingHasNoAcceptedAt");
    expect(invariant).toMatchObject({ phase: "ensures", ok: false });
    expect(res.trace!.outcome).toMatchObject({ ok: false, phase: "ensures", contract: "Contract:Invitation.invariant.pendingHasNoAcceptedAt" });
  });

  it("a tier-2 requires violation the app also rejects is recorded with ok: false", async () => {
    const res = await handle.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { email: "member@acme.io", role: "member" } });
    expect(res.status).toBe(409);
    expect(res.trace!.phases.find((p) => p.phase === "requires")).toMatchObject({ ok: false, evaluated: { "": { lhs: 1, rhs: "count == 0" } } });
    expect(res.trace!.outcome).toMatchObject({ ok: false, phase: "requires" });
  });

  it("validation mismatch: Averri's schema rejects what the app accepted", async () => {
    const res = await handle.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { email: "not-an-email", role: "member" } });
    expect(res.status).toBe(201);
    expect(res.trace!.phases[0]).toMatchObject({ phase: "validate", ok: false });
    expect(res.trace!.outcome).toMatchObject({ ok: false, phase: "validate" });
    const agreed = await handle.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { role: "member" } });
    expect(agreed.status).toBe(400);
    expect(agreed.trace!.outcome).toEqual({ ok: true });
    // requires/ensures are not evaluated over input the declared schema rejected
    expect(agreed.trace!.phases.map((p) => p.phase)).toEqual(["validate", "authorize", "authorize", "run"]);
  });

  it("subject rows back self/old in observe mode (findFirst before and after)", async () => {
    const res = await handle.request("anonymous", { method: "POST", path: "/invitations/pending@acme.io/resend" });
    expect(res.status).toBe(200);
    const phases = res.trace!.phases;
    expect(phases.find((p) => p.phase === "requires")).toMatchObject({ ok: true, contract: "Contract:Team.resendInvite.requires.isPending" });
    expect(phases.find((p) => p.phase === "ensures")).toMatchObject({ ok: true, contract: "Contract:Team.resendInvite.ensures.resent" });
    expect(phases.filter((p) => p.phase === "authorize").map((p) => (p as { decision: string }).decision)).toEqual(["public", "public"]);
    expect(prisma.$calls.filter((c) => c.model === "invitation" && c.op === "findFirst").length).toBe(2);
  });

  it("queries get validate/authorize only; unmatched routes pass through with trace: null", async () => {
    const list = await handle.request("member", { method: "GET", path: "/teams/t1/members" });
    expect(list.status).toBe(403);
    expect(list.trace!.action).toBe("Query:Team.listMembers");
    expect(list.trace!.phases.map((p) => p.phase)).toEqual(["validate", "authorize", "authorize", "run"]);
    const health = await handle.request("anonymous", { method: "GET", path: "/health" });
    expect(health).toEqual({ status: 200, body: "ok", trace: null });
    expect(recorder.traces.length).toBe(1);
  });

  it("rejects unknown actor fixtures", async () => {
    await expect(handle.request("nobody", { method: "GET", path: "/health" })).rejects.toBeInstanceOf(AverriRuntimeError);
  });

  it("works without a Prisma client: predicates fail closed, subject is null", async () => {
    const bare = await observe(buildHonoApp(prisma), { declarations, config, recorder: null });
    try {
      const res = await bare.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" } });
      expect(res.status).toBe(201);
      expect(res.trace!.phases.find((p) => p.phase === "requires")).toMatchObject({ ok: false });
      expect(res.trace!.phases.find((p) => p.phase === "authorize")).toMatchObject({ decision: "deny", observed: false });
    } finally {
      await bare.close();
    }
  });
});

describe("observe() over an Express app (ephemeral server)", () => {
  it("serves the listener on 127.0.0.1, evaluates contracts and closes", async () => {
    const prisma = createFakePrisma(seedTables());
    resetBus();
    const app = express();
    app.use(express.json());
    app.post("/teams/:teamId/invitations", async (req, res) => {
      const user = actorFromHeader(req.header("authorization"));
      if (!user) return res.status(401).json({ error: "unauthenticated" });
      const inv = await prisma.invitation!.create({ data: { teamId: req.params.teamId, email: req.body.email, role: req.body.role, status: "pending", acceptedAt: null } });
      await bus.send({ name: "averri/MemberInvited", data: { invitationId: inv.id } });
      return res.status(201).json(inv);
    });
    const handle = await observe(app, { declarations, config, prisma, recorder: null });
    const res = await handle.request("admin", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "new@acme.io" });
    expect(res.trace!.outcome).toEqual({ ok: true });
    expect(res.trace!.phases.filter((p) => p.phase === "ensures").every((p) => p.ok)).toBe(true);
    const anon = await handle.request("anonymous", { method: "POST", path: "/teams/t1/invitations", body: { email: "new@acme.io", role: "member" } });
    expect(anon.status).toBe(401);
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

describe("observe() old snapshot keeps Date and Decimal types (D-41b)", () => {
  const decimal = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
  const Touch = action("Team.touchInvitation", {
    route: { method: "POST", path: "/invitations/:email/touch" },
    input: z.object({ email: z.string() }),
    public: true,
    subject: { entity: Invitation, where: { email: e.input("email") } },
    ensures: {
      updatedAtAdvanced: e.gt("self.updatedAt", e.old("updatedAt")),
      amountGrew: e.gt("self.amount", e.old("amount")),
      createdAtStable: e.eq("self.createdAt", e.old("createdAt")),
    },
    effects: ["db:write"],
  });

  it("compares self.<date|decimal> with old.<same> instead of an ISO string", async () => {
    const tables = seedTables();
    tables.invitation = [
      { id: "inv_old", teamId: "t1", email: "pending@acme.io", status: "pending", acceptedAt: null, createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-02T00:00:00.000Z"), amount: decimal(10) },
    ];
    const prisma = createFakePrisma(tables);
    const app = new Hono();
    app.post("/invitations/:email/touch", async (c) => {
      const row = await prisma.invitation!.update({
        where: { email: c.req.param("email") },
        data: { updatedAt: new Date("2026-02-01T00:00:00.000Z"), amount: decimal(12.5) },
      });
      return c.json({ id: row.id });
    });
    const handle = await observe(app as never, { declarations: [Invitation, Touch], config, prisma, recorder: null });
    try {
      const res = await handle.request("anonymous", { method: "POST", path: "/invitations/pending@acme.io/touch" });
      expect(res.status).toBe(200);
      const ensures = res.trace!.phases.flatMap((p) => (p.phase === "ensures" && p.contract.startsWith("Contract:Team.touch") ? [p] : []));
      expect(ensures.map((p) => [p.contract, p.ok])).toEqual([
        ["Contract:Team.touchInvitation.ensures.updatedAtAdvanced", true],
        ["Contract:Team.touchInvitation.ensures.amountGrew", true],
        ["Contract:Team.touchInvitation.ensures.createdAtStable", true],
      ]);
    } finally {
      await handle.close();
    }
  });
});

describe("observe() DELETE with non-path input (D-41h)", () => {
  const RemoveMember = action("Team.removeMember", {
    route: { method: "DELETE", path: "/teams/:teamId/members/:userId" },
    input: z.object({ teamId: z.string(), userId: z.string(), reason: z.string() }),
    public: true,
    effects: ["db:write"],
  });

  it("the request the harness builds (JSON body for DELETE) is read back by observe, so the declared parse passes", async () => {
    const prisma = createFakePrisma(seedTables());
    const app = new Hono();
    app.delete("/teams/:teamId/members/:userId", async (c) => {
      const body = (await c.req.json()) as { reason?: string };
      return c.json({ removed: c.req.param("userId"), reason: body.reason });
    });
    const handle = await observe(app as never, { declarations: [RemoveMember], config, prisma, recorder: null });
    try {
      const sent = requestFor("DELETE", "/teams/:teamId/members/:userId", { teamId: "t1", userId: "u_member", reason: "left" });
      expect(sent.body).toEqual({ reason: "left" });
      const res = await handle.request("anonymous", { method: "DELETE", path: sent.path, body: sent.body });
      expect(res.status).toBe(200);
      expect(res.trace!.phases.find((p) => p.phase === "validate")).toMatchObject({ ok: true });
    } finally {
      await handle.close();
    }
  });
});
