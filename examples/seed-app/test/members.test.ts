import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers.js";

describe("members: list, role changes, removal", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("lists members with user details, filters by role and paginates", async () => {
    const res = await ctx.request("GET", "/orgs/org_acme/members", { as: "member" });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0]).toMatchObject({ organizationId: "org_acme", email: expect.any(String), name: expect.any(String) });
    const owners = await ctx.request("GET", "/orgs/org_acme/members?role=owner", { as: "member" });
    expect(owners.body.data.map((m: { userId: string }) => m.userId)).toEqual(["u_owner"]);
    const page = await ctx.request("GET", "/orgs/org_acme/members?limit=2", { as: "member" });
    expect(page.body.data).toHaveLength(2);
    expect(page.body.nextCursor).toBeTypeOf("string");
    expect((await ctx.request("GET", "/orgs/org_acme/members?role=king", { as: "member" })).status).toBe(400);
    expect((await ctx.request("GET", "/orgs/org_acme/members", { as: "otherAdmin" })).status).toBe(403);
    expect((await ctx.request("GET", "/orgs/org_acme/members")).status).toBe(401);
  });

  describe("PATCH /orgs/:orgId/members/:userId", () => {
    it("an admin promotes a member to admin and demotes back; an event and an audit entry are recorded", async () => {
      const up = await ctx.request("PATCH", "/orgs/org_acme/members/u_member", { as: "admin", body: { role: "admin" } });
      expect(up.status).toBe(200);
      expect(up.body).toMatchObject({ userId: "u_member", role: "admin" });
      expect(ctx.events.sent.at(-1)).toMatchObject({ name: "averri/MemberRoleChanged", data: { userId: "u_member", from: "member", to: "admin", changedBy: "u_admin" } });
      const down = await ctx.request("PATCH", "/orgs/org_acme/members/u_member", { as: "admin", body: { role: "member" } });
      expect(down.status).toBe(200);
      expect(down.body.role).toBe("member");
      const audit = await ctx.db.auditLog.findMany({ where: { organizationId: "org_acme", action: "member.role_changed" } });
      expect(audit).toHaveLength(2);
    });

    it("a no-op role change returns 200 without an event", async () => {
      const before = ctx.events.sent.length;
      const res = await ctx.request("PATCH", "/orgs/org_acme/members/u_member", { as: "owner", body: { role: "member" } });
      expect(res.status).toBe(200);
      expect(ctx.events.sent.length).toBe(before);
    });

    it("only owners grant or revoke the owner role", async () => {
      const grant = await ctx.request("PATCH", "/orgs/org_acme/members/u_member", { as: "admin", body: { role: "owner" } });
      expect(grant.status).toBe(403);
      expect(grant.body.error.code).toBe("owner_required");
      const demote = await ctx.request("PATCH", "/orgs/org_acme/members/u_owner", { as: "admin", body: { role: "member" } });
      expect(demote.status).toBe(403);
      expect(demote.body.error.code).toBe("owner_required");
    });

    it("the last owner cannot be demoted, but can be once a second owner exists", async () => {
      const last = await ctx.request("PATCH", "/orgs/org_acme/members/u_owner", { as: "owner", body: { role: "admin" } });
      expect(last.status).toBe(409);
      expect(last.body.error.code).toBe("last_owner");
      expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_admin", { as: "owner", body: { role: "owner" } })).status).toBe(200);
      expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_owner", { as: "owner", body: { role: "admin" } })).status).toBe(200);
      // restore: u_admin is owner now; make u_owner owner again and u_admin admin again
      expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_owner", { as: "admin", body: { role: "owner" } })).status).toBe(200);
      expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_admin", { as: "owner", body: { role: "admin" } })).status).toBe(200);
    });

    it("members cannot change roles; unknown users are 404; invalid roles are 400", async () => {
      expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_admin", { as: "member", body: { role: "member" } })).status).toBe(403);
      expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_ghost", { as: "owner", body: { role: "member" } })).status).toBe(404);
      expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_member", { as: "owner", body: { role: "king" } })).status).toBe(400);
      // Globex's owner is not a member of Acme.
      expect((await ctx.request("PATCH", "/orgs/org_acme/members/u_member", { as: "otherAdmin", body: { role: "admin" } })).status).toBe(403);
    });
  });

  describe("DELETE /orgs/:orgId/members/:userId", () => {
    it("members cannot remove others, admins cannot remove owners, the last owner cannot be removed", async () => {
      const byMember = await ctx.request("DELETE", "/orgs/org_acme/members/u_admin", { as: "member" });
      expect(byMember.status).toBe(403);
      const ownerByAdmin = await ctx.request("DELETE", "/orgs/org_acme/members/u_owner", { as: "admin" });
      expect(ownerByAdmin.status).toBe(403);
      expect(ownerByAdmin.body.error.code).toBe("owner_required");
      const lastOwner = await ctx.request("DELETE", "/orgs/org_acme/members/u_owner", { as: "owner" });
      expect(lastOwner.status).toBe(409);
      expect(lastOwner.body.error.code).toBe("last_owner");
      expect((await ctx.request("DELETE", "/orgs/org_acme/members/u_ghost", { as: "owner" })).status).toBe(404);
    });

    it("an admin removes a member: membership gone, their tasks unassigned, event emitted", async () => {
      const assignedBefore = await ctx.db.task.count({ where: { organizationId: "org_acme", assigneeId: "u_member" } });
      expect(assignedBefore).toBeGreaterThan(0);
      const res = await ctx.request("DELETE", "/orgs/org_acme/members/u_member", { as: "admin" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ userId: "u_member", role: "member", removed: true });
      expect(await ctx.db.membership.findUnique({ where: { organizationId_userId: { organizationId: "org_acme", userId: "u_member" } } })).toBeNull();
      expect(await ctx.db.task.count({ where: { organizationId: "org_acme", assigneeId: "u_member" } })).toBe(0);
      expect(ctx.events.sent.at(-1)).toMatchObject({ name: "averri/MemberRemoved", data: { userId: "u_member", removedBy: "u_admin", self: false } });
      expect((await ctx.request("GET", "/orgs/org_acme", { as: "member" })).status).toBe(403);
    });

    it("a member can leave on their own (self-removal), recorded as member.left", async () => {
      const accept = await ctx.request("POST", "/orgs/org_acme/invitations", { as: "owner", body: { email: "member@acme.test", role: "member" } });
      expect(accept.status).toBe(201);
      const token = (await ctx.db.invitation.findUniqueOrThrow({ where: { id: accept.body.id } })).token;
      expect((await ctx.request("POST", `/invitations/${token}/accept`, { as: "member" })).status).toBe(200);
      const leave = await ctx.request("DELETE", "/orgs/org_acme/members/u_member", { as: "member" });
      expect(leave.status).toBe(200);
      const audit = await ctx.db.auditLog.findFirst({ where: { organizationId: "org_acme", action: "member.left" } });
      expect(audit?.actorId).toBe("u_member");
    });
  });
});
