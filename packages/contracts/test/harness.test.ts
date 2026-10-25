/**
 * The generated-test harness (`createTestHarness`, D-40) and the schema-guided input sampler it uses.
 */
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { action, e, integration, query, workflow, type Actor } from "@averri/core";
import {
  collectDeclarations,
  conformInput,
  createTestHarness,
  memoryTraceRecorder,
  requestFor,
  resolveApp,
  sampleSchema,
  webhookSigner,
  type AverriTestHarness,
} from "../src/index.js";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { Invitation, MemberInvited, OwnerOrAdmin, bus, config, inviteInput, inviteRoute, resetBus, seedTables } from "./helpers/fixtures.js";

describe("schema-guided sampling", () => {
  it("samples strings, formats, enums, literals, bounded numbers, arrays and objects that the schema accepts", () => {
    const schemas = [
      z.string().min(3).max(5),
      z.email(),
      z.string().uuid(),
      z.iso.datetime(),
      z.enum(["a", "b"]),
      z.literal("x"),
      z.number().int().min(5).max(7),
      z.coerce.number().gt(0),
      z.array(z.string()).min(2),
      z.object({ a: z.string(), b: z.number().optional() }),
      z.string().nullable(),
      z.union([z.number(), z.string()]),
      z.boolean(),
      z.date(),
    ];
    for (const s of schemas) {
      const r = sampleSchema(s);
      expect(r.ok, String(s.def.type)).toBe(true);
      if (r.ok) expect(s.safeParse(r.value).success).toBe(true);
    }
  });

  it("uses the regex sampler for pattern formats and reports what it cannot sample", () => {
    const key = z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/);
    expect(sampleSchema(key).ok).toBe(false);
    const r = sampleSchema(key, { stringMatching: () => "AB12" });
    expect(r).toEqual({ ok: true, value: "AB12" });
    expect(sampleSchema(z.string().refine((v) => v === "never-sampled")).ok).toBe(false);
    // a transform is sampled on its input side
    expect(sampleSchema(z.string().transform((v) => v.length)).ok).toBe(true);
    expect(sampleSchema(z.custom<string>((v) => typeof v === "string")).ok).toBe(false);
  });

  it("conformInput keeps accepted fields, drops rejected optional ones and re-samples required ones", () => {
    const schema = z.object({ orgId: z.string().min(1), role: z.enum(["admin", "member"]), cursor: z.string().refine((v) => v.startsWith("c_")).optional() });
    expect(conformInput(schema, { orgId: "o1", role: "admin" })).toEqual({ orgId: "o1", role: "admin" });
    expect(conformInput(schema, { orgId: "o1", role: "owner", cursor: "bogus" })).toEqual({ orgId: "o1", role: "admin" });
    expect(conformInput(schema, {})).toMatchObject({ role: "admin" });
    expect(conformInput(z.object({ k: z.string().refine(() => false) }), {})).toBeNull();
    expect(conformInput("not a schema", {})).toBeNull();
  });
});

describe("harness helpers", () => {
  it("requestFor substitutes path params and sends the rest as query (GET/HEAD) or body (D-41h)", () => {
    expect(requestFor("POST", "/teams/:teamId/invitations", { teamId: "t 1", email: "a@b.c" })).toEqual({ path: "/teams/t%201/invitations", body: { email: "a@b.c" } });
    expect(requestFor("GET", "/teams/:teamId/members", { teamId: "t1", limit: 5, tags: ["a", "b"], skip: undefined })).toEqual({ path: "/teams/t1/members?limit=5&tags=a&tags=b" });
    expect(requestFor("DELETE", "/x/:id", { id: "1" })).toEqual({ path: "/x/1" });
    expect(requestFor("DELETE", "/x/:id", { id: "1", reason: "spam" })).toEqual({ path: "/x/1", body: { reason: "spam" } });
    expect(requestFor("HEAD", "/x/:id", { id: "1", full: true })).toEqual({ path: "/x/1?full=true" });
    expect(() => requestFor("GET", "/x/:id", {})).toThrow(/path parameter "id"/);
  });

  it("collects declarations from direct exports and arrays, first id wins", () => {
    const byId = collectDeclarations([{ a: Invitation, list: [OwnerOrAdmin, MemberInvited], other: 1 }, { again: Invitation }]);
    expect([...byId.keys()].sort()).toEqual(["Entity:Invitation", "Event:MemberInvited", "Policy:Team.OwnerOrAdmin"]);
  });

  it("resolves the app from default, app or { app }", () => {
    const app = new Hono();
    expect(resolveApp({ default: app })).toBe(app);
    expect(resolveApp({ app })).toBe(app);
    expect(resolveApp({ default: { app, deps: {} } })).toBe(app);
    const listener = (): void => undefined;
    expect(resolveApp({ app: listener })).toBe(listener);
    expect(resolveApp({ createApp: () => app })).toBeNull();
    expect(resolveApp(null)).toBeNull();
  });

  it("signs requests to a declared webhook route (stripe and hmac-sha256) when the secret is set", () => {
    const Stripe = integration("Stripe", {
      client: {},
      webhook: { verify: "stripe-signature", scheme: "stripe", secretEnv: "WH_SECRET", rawBody: true, route: { method: "POST", path: "/webhooks/stripe" } },
    });
    const Gh = integration("Github", {
      client: {},
      webhook: { verify: "x-hub-signature-256", scheme: "hmac-sha256", secretEnv: "GH_SECRET", rawBody: true, route: { method: "POST", path: "/webhooks/github" } },
    });
    const env = { WH_SECRET: "whsec", GH_SECRET: "ghs" };
    const stripe = webhookSigner([Stripe, Gh], "POST", "/webhooks/stripe/", env);
    const header = stripe?.("{}")["stripe-signature"] ?? "";
    const [t, v1] = header.split(",").map((p) => p.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", "whsec").update(`${t}.{}`).digest("hex"));
    expect(webhookSigner([Stripe, Gh], "POST", "/webhooks/github", env)?.("x")).toEqual({ "x-hub-signature-256": createHmac("sha256", "ghs").update("x").digest("hex") });
    expect(webhookSigner([Stripe], "POST", "/webhooks/stripe", {})).toBeNull();
    expect(webhookSigner([Stripe], "POST", "/other", env)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createTestHarness over a Hono app (observe mode)
// ---------------------------------------------------------------------------

const InviteMember = action("Team.inviteMember", {
  route: inviteRoute,
  input: inviteInput,
  output: Invitation,
  policy: OwnerOrAdmin,
  ensures: { eventEmitted: e.emitted(MemberInvited, 1) },
  effects: ["db:write", "event:emit"],
});
const Ping = query("Team.ping", { route: { method: "GET", path: "/ping" }, input: z.object({}), public: true });
const runner = { event: "averri/MemberInvited" };
const InviteFlow = workflow("InviteFlow", { on: MemberInvited, runner });

function actorOf(header: string | undefined): Actor | null {
  if (header === "Bearer admin") return { id: "u_admin" };
  if (header === "Bearer member") return { id: "u_member" };
  if (header === "Bearer other") return { id: "u_other" };
  return null;
}

function buildApp(prisma: FakePrisma): Hono {
  const app = new Hono();
  app.get("/ping", (c) => c.json({ ok: true }));
  app.post("/teams/:teamId/invitations", async (c) => {
    const actor = actorOf(c.req.header("authorization"));
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const teamId = c.req.param("teamId");
    if (teamId === "t_missing") return c.json({ error: "not found" }, 404);
    const allowed = await prisma.membership!.count({ where: { teamId, userId: actor.id, role: { in: ["owner", "admin"] } } });
    if (allowed === 0) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json()) as { email: string; role: string };
    const inv = await prisma.invitation!.create({ data: { teamId, email: body.email, role: body.role, status: "pending", acceptedAt: null } });
    await bus.send({ name: "averri/MemberInvited", data: { invitationId: inv.id } });
    return c.json(inv, 201);
  });
  app.post("/raw", async (c) => c.json({ len: (await c.req.text()).length }));
  return app;
}

describe("createTestHarness", () => {
  let prisma: FakePrisma;
  let h: AverriTestHarness;
  const recorder = memoryTraceRecorder();

  beforeEach(async () => {
    resetBus();
    recorder.clear();
    prisma = createFakePrisma(seedTables());
    h = await createTestHarness({ config, app: { default: buildApp(prisma) }, modules: [{ InviteMember, Ping, InviteFlow, list: [Invitation, OwnerOrAdmin, MemberInvited] }], prisma, recorder });
  });
  afterEach(async () => {
    await h.close();
  });

  it("invokes an observe-mode action as a fixture: status, body, trace with the emit record, emitted payloads", async () => {
    const res = await h.invoke("Action:Team.inviteMember", "admin", { teamId: "t1", email: "new@acme.io", role: "member" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "new@acme.io", status: "pending" });
    expect(res.trace?.phases.find((p) => p.phase === "emit")).toMatchObject({ ok: true, events: [{ event: "Event:MemberInvited" }] });
    expect(h.emitted()).toEqual([{ event: "Event:MemberInvited", payload: { invitationId: expect.any(String) } }]);
    expect(recorder.traces).toHaveLength(1);
    const anon = await h.invoke("Action:Team.inviteMember", "anonymous", { teamId: "t1", email: "x@acme.io", role: "member" });
    expect(anon.status).toBe(401);
    expect(h.emitted()).toEqual([]);
  });

  it("records a 404 as the app's denial when the declared policy denies", async () => {
    const res = await h.invoke("Action:Team.inviteMember", "member", { teamId: "t_missing", email: "x@acme.io", role: "member" });
    expect(res.status).toBe(404);
    expect(res.trace?.phases.filter((p) => p.phase === "authorize").map((p) => p.decision)).toEqual(["deny", "deny"]);
    expect(res.trace?.outcome.ok).toBe(true);
  });

  it("evaluates the declared policy per fixture", async () => {
    const input = { teamId: "t1", email: "a@acme.io", role: "member" };
    expect(await h.policyDecision("Action:Team.inviteMember", "admin", input)).toBe("allow");
    expect(await h.policyDecision("Action:Team.inviteMember", "member", input)).toBe("deny");
    expect(await h.policyDecision("Action:Team.inviteMember", "anonymous", input)).toBe("unauthenticated");
    expect(await h.policyDecision("Query:Team.ping", "member", {})).toBe("public");
    await expect(h.policyDecision("Action:Team.inviteMember", "nobody", input)).rejects.toThrow(/unknown actor fixture/);
    await expect(h.policyDecision("Action:Nope", "admin", input)).rejects.toThrow(/not exported/);
  });

  it("parses and conforms input with the declared schema; exposes fixtures' actors", () => {
    expect(h.parseInput("Action:Team.inviteMember", { teamId: "t1", email: "bad", role: "member" }).ok).toBe(false);
    expect(h.conformInput("Action:Team.inviteMember", { teamId: "t1", email: "bad", role: "owner" })).toMatchObject({ teamId: "t1", role: "admin" });
    expect(h.actor("admin")).toMatchObject({ id: "u_admin" });
    expect(h.actor("anonymous")).toBeNull();
  });

  it("snapshots models in id order, checks entity invariants and workflow registration", async () => {
    const snap = await h.snapshot(["membership"]);
    expect((snap.membership as Array<{ id: string }>).map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect(await h.invariantViolations("Entity:Invitation")).toEqual([]);
    await prisma.invitation!.create({ data: { id: "inv_bad", status: "pending", acceptedAt: new Date() } });
    expect(await h.invariantViolations("Entity:Invitation")).toEqual([{ contract: "Contract:Invitation.invariant.pendingHasNoAcceptedAt", row: expect.objectContaining({ id: "inv_bad" }) }]);
    expect(await h.consumerRegistered("Event:MemberInvited", "Workflow:InviteFlow")).toBe(true);
    expect(await h.consumerRegistered("Event:Other", "Workflow:InviteFlow")).toBe(false);
    expect(await h.consumerRegistered("Event:MemberInvited", "Workflow:Nope")).toBe(false);
  });

  it("consumerRegistered fails closed when nothing can be verified (D-41i)", async () => {
    const make = async (flow: unknown, target: unknown): Promise<AverriTestHarness> =>
      createTestHarness({
        config: { ...config, emitter: { ...config.emitter!, spy: { target: target as never, method: "send" } } } as never,
        app: { default: buildApp(prisma) },
        modules: [{ InviteMember, Ping, Flow: flow, list: [Invitation, OwnerOrAdmin, MemberInvited] }],
        prisma,
        recorder,
      });
    // non-inspectable emitter + a runner that names no event: unverifiable, so not "registered"
    const silent = await make(workflow("InviteFlow", { on: MemberInvited, runner: { handle: () => undefined } }), bus);
    try {
      expect(await silent.consumerRegistered("Event:MemberInvited", "Workflow:InviteFlow")).toBe(false);
    } finally {
      await silent.close();
    }
    // non-inspectable emitter + a runner that names the event: that is evidence
    const named = await make(workflow("InviteFlow", { on: MemberInvited, runner: { event: "averri/MemberInvited" } }), bus);
    try {
      expect(await named.consumerRegistered("Event:MemberInvited", "Workflow:InviteFlow")).toBe(true);
    } finally {
      await named.close();
    }
    // inspectable emitter: the listener count decides, whatever the runner object says
    const counts: Record<string, number> = { "averri/MemberInvited": 0 };
    const inspectable = { send: bus.send, listenerCount: (name: string) => counts[name] ?? 0 };
    const listened = await make(workflow("InviteFlow", { on: MemberInvited, runner: { handle: () => undefined } }), inspectable);
    try {
      expect(await listened.consumerRegistered("Event:MemberInvited", "Workflow:InviteFlow")).toBe(false);
      counts["averri/MemberInvited"] = 1;
      expect(await listened.consumerRegistered("Event:MemberInvited", "Workflow:InviteFlow")).toBe(true);
    } finally {
      await listened.close();
    }
  });

  it("sends raw requests verbatim", async () => {
    const res = await h.rawRequest({ method: "POST", path: "/raw", headers: { "content-type": "text/plain" }, body: "{ \"a\" : 1 }" });
    expect(res).toEqual({ status: 200, body: { len: 11 } });
  });

  it("requires an app for observe-mode declarations", async () => {
    await expect(createTestHarness({ config, app: null, modules: [{ InviteMember }], prisma })).rejects.toThrow(/default` or `app`/);
  });
});
