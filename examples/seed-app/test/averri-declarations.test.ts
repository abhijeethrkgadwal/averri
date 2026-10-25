/**
 * The Averri declarations are plain data; these tests check that they load, that every declared
 * route exists in the real app, that policies/contracts are the tiers we intend, and that the actor
 * fixtures in averri.config.ts resolve through the app's own auth middleware against the seed data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { averriMeta, isDeclaration, tierOf, type AnyActionDecl, type AnyQueryDecl } from "@averri/core";
import config from "../averri.config.js";
import { actions, declarations, entities, events as eventDecls, integrations, policies, queries, workflows } from "../src/averri/index.js";
import { Prisma } from "../src/db.js";
import { createTestContext, type TestContext } from "./helpers.js";

describe("averri declarations", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("every declaration is a frozen @averri/core declaration with a unique id", () => {
    expect(declarations.length).toBeGreaterThanOrEqual(30);
    const ids = new Set<string>();
    for (const decl of declarations) {
      expect(isDeclaration(decl)).toBe(true);
      expect(Object.isFrozen(decl)).toBe(true);
      const id = averriMeta(decl).id;
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it("declares at least the eight required actions, all in observe mode with a route and declared effects", () => {
    const required = ["Org.inviteMember", "Org.acceptInvite", "Org.createProject", "Org.createTask", "Org.rotateApiKey", "Billing.handleStripeWebhook", "Org.removeMember", "Org.updateMemberRole"];
    const ids = actions.map((a) => a.id);
    for (const id of required) expect(ids).toContain(id);
    expect(actions.length).toBeGreaterThanOrEqual(8);
    for (const action of actions as readonly AnyActionDecl[]) {
      const meta = averriMeta(action);
      expect(meta.kind).toBe("action");
      expect(action.mode).toBe("observe");
      expect(meta.route).not.toBeNull();
      expect(meta.transaction).toBe(false);
      expect(action.options.effects.length).toBeGreaterThan(0);
      expect(action.options.intent).toBeTypeOf("string");
    }
  });

  it("every declared route matches a registered Hono route (method + path template)", () => {
    const registered = new Set(ctx.app.routes.map((r) => `${r.method} ${r.path}`));
    const declared = [...(actions as readonly AnyActionDecl[]), ...(queries as readonly AnyQueryDecl[])].map((d) => averriMeta(d).route).filter((r) => r !== null);
    expect(declared.length).toBe(actions.length + queries.length);
    for (const route of declared) {
      expect(registered.has(`${route.method} ${route.path}`), `${route.method} ${route.path}`).toBe(true);
    }
    const webhookRoute = integrations[0].options.webhook?.route;
    expect(webhookRoute && registered.has(`${webhookRoute.method} ${webhookRoute.path}`)).toBe(true);
  });

  it("entity names are Prisma model names and every model with business rules has an entity", () => {
    const models = new Set<string>(Object.values(Prisma.ModelName));
    for (const entity of entities) {
      expect(models.has(entity.name), entity.name).toBe(true);
      expect(averriMeta(entity).clientName).toBe(entity.name[0]!.toLowerCase() + entity.name.slice(1));
    }
    for (const model of models) expect(entities.map((e) => e.name)).toContain(model);
    const invitation = entities.find((e) => e.name === "Invitation")!;
    expect(averriMeta(invitation).contracts.map((c) => c.id)).toContain("Contract:Invitation.invariant.pendingHasNoAcceptedAt");
    for (const c of averriMeta(invitation).contracts) expect(c.tier).toBe("expr");
  });

  it("policies are analysable (no guards), so the auth matrix is derivable for every action", () => {
    for (const policy of policies) {
      const meta = averriMeta(policy);
      expect(meta.tier).not.toBe("guard");
      expect(meta.contracts[0]?.id).toBe(`Contract:${policy.id}.allow`);
    }
    const guardActions = (actions as readonly AnyActionDecl[]).filter((a) => averriMeta(a).contracts.some((c) => c.tier === "guard"));
    expect(guardActions).toEqual([]);
  });

  it("contracts have the expected tiers and ids (worked-example parity for inviteMember)", () => {
    const invite = actions.find((a) => a.id === "Org.inviteMember")!;
    const contracts = averriMeta(invite as AnyActionDecl).contracts;
    const byClause = Object.fromEntries(contracts.map((c) => [c.clause, c]));
    expect(byClause.notAlreadyMember?.id).toBe("Contract:Org.inviteMember.requires.notAlreadyMember");
    expect(byClause.notAlreadyMember?.tier).toBe("predicate");
    expect(byClause.notAlreadyMember?.expr).toEqual({ op: "db.none", model: "membership", where: { organizationId: { ref: "input.orgId" }, "user.email": { ref: "input.email" } } });
    expect(byClause.pendingForEmail?.tier).toBe("expr");
    expect(byClause.eventEmitted?.expr).toEqual({ op: "emitted", event: "Event:MemberInvited", count: 1 });
    expect(contracts.map((c) => c.phase)).toEqual(["requires", "requires", "ensures", "ensures", "ensures", "ensures", "ensures"]);
    expect(tierOf(invite.options.requires!.notAlreadyMember!)).toBe("predicate");
  });

  it("events, workflow and integration are wired to the application's names", () => {
    const names = eventDecls.map((e) => e.name);
    for (const sent of ["MemberInvited", "InvitationAccepted", "MemberRemoved", "MemberRoleChanged", "ProjectCreated", "TaskCreated", "ApiKeyRotated", "SubscriptionChanged"]) {
      expect(names).toContain(sent);
    }
    const inviteFlow = workflows[0];
    expect(inviteFlow.options.on.name).toBe("MemberInvited");
    expect((inviteFlow.options.runner as { event: string }).event).toBe(`${config.emitter!.eventNamePrefix}MemberInvited`);
    expect(ctx.events.subscriberCount("averri/MemberInvited")).toBe(1);
    const stripe = integrations[0];
    expect(stripe.options.webhook).toMatchObject({ verify: "stripe-signature", scheme: "stripe", secretEnv: "STRIPE_WEBHOOK_SECRET", rawBody: true });
    expect(stripe.options.idempotency).toEqual({ key: { input: "id" }, ttlSeconds: 2_592_000 });
  });

  it("averri.config.ts resolves defaults, keeps the mandatory anonymous fixture and the spy targets the bus", () => {
    expect(config.actors.anonymous).toEqual({ actor: null });
    expect(config.entryPoints).toEqual(["src/app.ts"]);
    expect(config.test).toEqual({ databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" });
    expect(config.emitter?.spy.method).toBe("send");
    expect(typeof (config.emitter?.spy.target as { send: unknown }).send).toBe("function");
    expect(config.authMiddleware).toContain("auth");
  });

  it("every actor fixture's headers resolve to the fixture's actor id through the real auth middleware", async () => {
    for (const [name, fixture] of Object.entries(config.actors)) {
      const res = await ctx.request("GET", "/orgs/org_acme", { headers: fixture.headers ?? {} });
      if (fixture.actor === null) {
        expect(res.status, name).toBe(401);
        continue;
      }
      if (fixture.actor.orgId === "org_acme") {
        expect(res.status, name).toBe(200);
        expect(res.body.role, name).toBe(fixture.actor.role);
      } else {
        expect(res.status, name).toBe(403);
      }
      if (fixture.actor.type === "user") {
        const me = await ctx.request("GET", "/me", { headers: fixture.headers ?? {} });
        expect(me.body.id, name).toBe(fixture.actor.id);
      }
    }
  });
});
