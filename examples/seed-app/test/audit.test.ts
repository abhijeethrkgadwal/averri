import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers.js";

describe("audit log", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("records member changes with actor, target and metadata, newest first, and filters by action/targetType", async () => {
    ctx.clock.advance(1000);
    expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_member", { as: "owner", body: { role: "admin" } })).status).toBe(200);
    ctx.clock.advance(1000);
    expect((await ctx.request("POST", "/orgs/org_acme/projects", { as: "owner", body: { name: "Audit Me", key: "AUD" } })).status).toBe(201);
    ctx.clock.advance(1000);
    expect((await ctx.request("POST", "/orgs/org_acme/invitations", { as: "admin", body: { email: "audit@example.test", role: "member" } })).status).toBe(201);

    const res = await ctx.request("GET", "/orgs/org_acme/audit-log", { as: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: { action: string }) => a.action)).toEqual(["invitation.created", "project.created", "member.role_changed", "seed.loaded"]);
    expect(res.body.data[2]).toMatchObject({
      actor: { type: "user", id: "u_owner" },
      action: "member.role_changed",
      target: { type: "membership", id: expect.any(String) },
      metadata: { userId: "u_member", from: "member", to: "admin" },
    });

    const filtered = await ctx.request("GET", "/orgs/org_acme/audit-log?action=project.created", { as: "admin" });
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].metadata).toEqual({ key: "AUD" });
    const byType = await ctx.request("GET", "/orgs/org_acme/audit-log?targetType=invitation", { as: "admin" });
    expect(byType.body.data.map((a: { actor: { id: string } }) => a.actor.id)).toEqual(["u_admin"]);
  });

  it("paginates with a cursor and is scoped to the organization", async () => {
    const page1 = await ctx.request("GET", "/orgs/org_acme/audit-log?limit=3", { as: "owner" });
    expect(page1.body.data).toHaveLength(3);
    const page2 = await ctx.request("GET", `/orgs/org_acme/audit-log?limit=3&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { as: "owner" });
    expect(page2.body.data.map((a: { action: string }) => a.action)).toEqual(["seed.loaded"]);
    expect(page2.body.nextCursor).toBeNull();
    const globex = await ctx.request("GET", "/orgs/org_globex/audit-log", { as: "otherAdmin" });
    expect(globex.body.data).toEqual([]);
    expect((await ctx.request("GET", "/orgs/org_acme/audit-log", { as: "outsider" })).status).toBe(403);
  });

  it("entries written by API keys carry actorType apiKey", async () => {
    const res = await ctx.request("POST", "/orgs/org_acme/projects/proj_website/tasks", { as: { token: ctx.seed.apiKeys.acmeMember.secret }, body: { title: "via key" } });
    expect(res.status).toBe(201);
    const entry = await ctx.db.auditLog.findFirst({ where: { targetId: res.body.id } });
    expect(entry).toMatchObject({ actorType: "apiKey", actorId: ctx.seed.apiKeys.acmeMember.id, action: "task.created" });
  });
});
