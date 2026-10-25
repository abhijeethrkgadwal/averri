import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers.js";

describe("organizations", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("creating an organization makes the creator its owner, opens a free subscription and writes an audit entry", async () => {
    const res = await ctx.request("POST", "/orgs", { as: "outsider", body: { name: "Outsider Co", slug: "outsider-co" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: "outsider-co", name: "Outsider Co", role: "owner" });
    const orgId = res.body.id as string;
    const membership = await ctx.db.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId: "u_outsider" } } });
    expect(membership?.role).toBe("owner");
    const subscription = await ctx.db.subscription.findUnique({ where: { organizationId: orgId } });
    expect(subscription).toMatchObject({ plan: "free", status: "active", seats: 1 });
    const audit = await ctx.db.auditLog.findMany({ where: { organizationId: orgId } });
    expect(audit.map((a) => a.action)).toEqual(["organization.created"]);
  });

  it("rejects duplicate slugs (409), invalid slugs (400) and anonymous callers (401)", async () => {
    expect((await ctx.request("POST", "/orgs", { as: "outsider", body: { name: "Again", slug: "acme" } })).status).toBe(409);
    expect((await ctx.request("POST", "/orgs", { as: "outsider", body: { name: "Bad", slug: "Not Valid!" } })).status).toBe(400);
    expect((await ctx.request("POST", "/orgs", { body: { name: "Anon", slug: "anon-org" } })).status).toBe(401);
  });

  it("GET /orgs lists only the caller's organizations and paginates by cursor", async () => {
    for (let i = 0; i < 5; i++) {
      ctx.clock.advance(1000);
      const res = await ctx.request("POST", "/orgs", { as: "outsider", body: { name: `Paged ${i}`, slug: `paged-${i}` } });
      expect(res.status).toBe(201);
    }
    const page1 = await ctx.request("GET", "/orgs?limit=4", { as: "outsider" });
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(4);
    expect(page1.body.nextCursor).toBeTypeOf("string");
    const page2 = await ctx.request("GET", `/orgs?limit=4&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { as: "outsider" });
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.nextCursor).toBeNull();
    const ids = [...page1.body.data, ...page2.body.data].map((o: { id: string }) => o.id);
    expect(new Set(ids).size).toBe(6);
    expect(ids).not.toContain("org_acme");

    const member = await ctx.request("GET", "/orgs", { as: "member" });
    expect(member.body.data.map((o: { slug: string; role: string }) => [o.slug, o.role])).toEqual([["acme", "member"]]);

    const badCursor = await ctx.request("GET", "/orgs?cursor=garbage", { as: "member" });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe("invalid_cursor");
    expect((await ctx.request("GET", "/orgs?limit=1000", { as: "member" })).status).toBe(400);
  });

  it("GET /orgs/:orgId returns counts and the caller's role; non-members get 403", async () => {
    const res = await ctx.request("GET", "/orgs/org_acme", { as: "admin" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "org_acme", role: "admin", memberCount: 3, activeProjectCount: 2, plan: "pro", subscriptionStatus: "active" });
    const other = await ctx.request("GET", "/orgs/org_acme", { as: "otherAdmin" });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("not_a_member");
    expect((await ctx.request("GET", "/orgs/org_missing", { as: "admin" })).status).toBe(404);
  });

  it("PATCH /orgs/:orgId needs owner or admin and validates the body", async () => {
    expect((await ctx.request("PATCH", "/orgs/org_acme", { as: "member", body: { name: "Nope" } })).status).toBe(403);
    expect((await ctx.request("PATCH", "/orgs/org_acme", { as: "admin", body: {} })).status).toBe(400);
    const ok = await ctx.request("PATCH", "/orgs/org_acme", { as: "admin", body: { name: "Acme Incorporated" } });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("Acme Incorporated");
    const taken = await ctx.request("PATCH", "/orgs/org_acme", { as: "owner", body: { slug: "globex" } });
    expect(taken.status).toBe(409);
  });

  it("DELETE /orgs/:orgId is owner-only and soft-deletes: keys revoked, invitations revoked, org invisible", async () => {
    expect((await ctx.request("DELETE", "/orgs/org_acme", { as: "admin" })).status).toBe(403);
    const res = await ctx.request("DELETE", "/orgs/org_acme", { as: "owner" });
    expect(res.status).toBe(200);
    expect(res.body.deletedAt).toBe(ctx.clock.now.toISOString());
    const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: "org_acme" } });
    expect(org.deletedAt).not.toBeNull();
    expect((await ctx.request("GET", "/orgs/org_acme", { as: "owner" })).status).toBe(404);
    expect((await ctx.request("GET", "/orgs", { as: "owner" })).body.data).toEqual([]);
    expect((await ctx.request("GET", "/orgs/org_acme", { as: { token: ctx.seed.apiKeys.acmeMember.secret } })).status).toBe(401);
    const invitation = await ctx.db.invitation.findUniqueOrThrow({ where: { id: "inv_pending" } });
    expect(invitation.status).toBe("revoked");
  });
});
