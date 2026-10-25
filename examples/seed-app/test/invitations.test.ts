import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVITATION_TTL_MS } from "../src/lib/constants.js";
import { createTestContext, type TestContext } from "./helpers.js";

describe("invitations", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("an admin invites a new email: pending invitation, MemberInvited event, InviteFlow sends the email", async () => {
    const res = await ctx.request("POST", "/orgs/org_acme/invitations", { as: "admin", body: { email: "Dana@Example.test", role: "member" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ organizationId: "org_acme", email: "dana@example.test", role: "member", status: "pending", resendCount: 0, invitedById: "u_admin" });
    expect(res.body.token).toBeUndefined();
    expect(new Date(res.body.expiresAt).getTime()).toBe(ctx.clock.now.getTime() + INVITATION_TTL_MS);

    const event = ctx.events.sent.find((e) => e.name === "averri/MemberInvited" && e.data.email === "dana@example.test");
    expect(event).toBeDefined();
    expect(ctx.workflows.inviteFlow.runs.at(-1)).toMatchObject({ ok: true, steps: [{ name: "load", ok: true }, { name: "email", ok: true }] });
    const mail = ctx.mailer.outbox.at(-1);
    expect(mail?.to).toBe("dana@example.test");
    expect(mail?.subject).toBe("Adam Admin invited you to Acme Inc");
    expect(mail?.text).toContain(`http://app.test/invitations/${event?.data.token}`);
  });

  it("re-inviting a pending email resends (same invitation, resendCount + 1, role updated) and emits again", async () => {
    const sentBefore = ctx.events.sent.filter((e) => e.name === "averri/MemberInvited").length;
    ctx.clock.advance(60_000);
    const res = await ctx.request("POST", "/orgs/org_acme/invitations", { as: "owner", body: { email: "dana@example.test", role: "admin" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "dana@example.test", role: "admin", status: "pending", resendCount: 1, invitedById: "u_owner" });
    expect(res.body.resentAt).toBe(ctx.clock.now.toISOString());
    expect(await ctx.db.invitation.count({ where: { organizationId: "org_acme", email: "dana@example.test" } })).toBe(1);
    expect(ctx.events.sent.filter((e) => e.name === "averri/MemberInvited").length).toBe(sentBefore + 1);
  });

  it("inviting an existing member is 409; members and outsiders cannot invite; API keys cannot invite", async () => {
    const dup = await ctx.request("POST", "/orgs/org_acme/invitations", { as: "owner", body: { email: "member@acme.test", role: "member" } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("already_member");
    expect((await ctx.request("POST", "/orgs/org_acme/invitations", { as: "member", body: { email: "x@example.test", role: "member" } })).status).toBe(403);
    expect((await ctx.request("POST", "/orgs/org_acme/invitations", { as: "otherAdmin", body: { email: "x@example.test", role: "member" } })).status).toBe(403);
    expect((await ctx.request("POST", "/orgs/org_acme/invitations", { body: { email: "x@example.test", role: "member" } })).status).toBe(401);
    const byKey = await ctx.request("POST", "/orgs/org_acme/invitations", { as: { token: ctx.seed.apiKeys.acmeAdmin.secret }, body: { email: "x@example.test", role: "member" } });
    expect(byKey.status).toBe(403);
    expect(byKey.body.error.code).toBe("user_required");
    expect((await ctx.request("POST", "/orgs/org_acme/invitations", { as: "owner", body: { email: "x@example.test", role: "owner" } })).status).toBe(400);
  });

  it("lists invitations by status (expired is derived from expiresAt)", async () => {
    const all = await ctx.request("GET", "/orgs/org_acme/invitations", { as: "admin" });
    expect(all.status).toBe(200);
    expect(all.body.data.map((i: { email: string }) => i.email).sort()).toEqual(["dana@example.test", "pending@acme.test"]);
    // The seeded invitation expires at T+7d; dana's was resent at T+60s and expires at T+60s+7d.
    ctx.clock.advance(INVITATION_TTL_MS - 30_000);
    const expired = await ctx.request("GET", "/orgs/org_acme/invitations?status=expired", { as: "admin" });
    expect(expired.body.data.map((i: { email: string; status: string }) => [i.email, i.status])).toEqual([["pending@acme.test", "expired"]]);
    const pending = await ctx.request("GET", "/orgs/org_acme/invitations?status=pending", { as: "admin" });
    expect(pending.body.data.map((i: { email: string }) => i.email)).toEqual(["dana@example.test"]);
    ctx.clock.advance(-(INVITATION_TTL_MS - 30_000));
    expect((await ctx.request("GET", "/orgs/org_acme/invitations", { as: "member" })).status).toBe(403);
  });

  it("resend bumps the counter and extends expiry; revoke ends it; both are tenant-scoped", async () => {
    const resend = await ctx.request("POST", "/orgs/org_acme/invitations/inv_pending/resend", { as: "admin" });
    expect(resend.status).toBe(200);
    expect(resend.body.resendCount).toBe(1);
    expect(new Date(resend.body.expiresAt).getTime()).toBe(ctx.clock.now.getTime() + INVITATION_TTL_MS);
    expect((await ctx.request("POST", "/orgs/org_globex/invitations/inv_pending/resend", { as: "otherAdmin" })).status).toBe(404);

    const revoke = await ctx.request("DELETE", "/orgs/org_acme/invitations/inv_pending", { as: "owner" });
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe("revoked");
    expect(revoke.body.revokedAt).toBe(ctx.clock.now.toISOString());
    const again = await ctx.request("POST", "/orgs/org_acme/invitations/inv_pending/resend", { as: "admin" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("not_pending");
    expect((await ctx.request("DELETE", "/orgs/org_acme/invitations/inv_pending", { as: "owner" })).status).toBe(409);
    expect((await ctx.request("DELETE", "/orgs/org_acme/invitations/inv_missing", { as: "owner" })).status).toBe(404);
  });

  it("re-inviting a revoked email reissues a fresh invitation with a new token", async () => {
    const before = await ctx.db.invitation.findUniqueOrThrow({ where: { id: "inv_pending" } });
    const res = await ctx.request("POST", "/orgs/org_acme/invitations", { as: "admin", body: { email: "pending@acme.test", role: "member" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "inv_pending", status: "pending", resendCount: 0, revokedAt: null });
    const after = await ctx.db.invitation.findUniqueOrThrow({ where: { id: "inv_pending" } });
    expect(after.token).not.toBe(before.token);
  });

  it("GET /invitations/:token is public and reveals only what the landing page needs", async () => {
    const token = (await ctx.db.invitation.findUniqueOrThrow({ where: { id: "inv_pending" } })).token;
    const res = await ctx.request("GET", `/invitations/${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      organizationName: "Acme Inc",
      invitedBy: "Adam Admin",
      email: "pending@acme.test",
      role: "member",
      status: "pending",
      expiresAt: expect.any(String),
    });
    expect((await ctx.request("GET", "/invitations/inv_nope_nope")).status).toBe(404);
  });

  describe("accepting", () => {
    it("requires a signed-in user whose email matches", async () => {
      const token = (await ctx.db.invitation.findUniqueOrThrow({ where: { id: "inv_pending" } })).token;
      expect((await ctx.request("POST", `/invitations/${token}/accept`)).status).toBe(401);
      const mismatch = await ctx.request("POST", `/invitations/${token}/accept`, { as: "outsider" });
      expect(mismatch.status).toBe(403);
      expect(mismatch.body.error.code).toBe("email_mismatch");
    });

    it("creates the membership, marks the invitation accepted and emits InvitationAccepted", async () => {
      const reg = await ctx.request("POST", "/auth/register", { body: { email: "pending@acme.test", name: "Penny Pending", password: "password123" } });
      const token = (await ctx.db.invitation.findUniqueOrThrow({ where: { id: "inv_pending" } })).token;
      const res = await ctx.request("POST", `/invitations/${token}/accept`, { as: { token: reg.body.token } });
      expect(res.status).toBe(200);
      expect(res.body.invitation).toMatchObject({ status: "accepted", acceptedById: reg.body.user.id });
      expect(res.body.membership).toMatchObject({ organizationId: "org_acme", userId: reg.body.user.id, role: "member" });
      expect(res.body.organization).toEqual({ id: "org_acme", slug: "acme", name: "Acme Inc" });
      expect(ctx.events.sent.at(-1)).toMatchObject({ name: "averri/InvitationAccepted", data: { invitationId: "inv_pending", userId: reg.body.user.id } });
      const twice = await ctx.request("POST", `/invitations/${token}/accept`, { as: { token: reg.body.token } });
      expect(twice.status).toBe(409);
      expect(twice.body.error.code).toBe("not_pending");
      expect((await ctx.request("GET", "/orgs/org_acme", { as: { token: reg.body.token } })).body.role).toBe("member");
    });

    it("expired invitations answer 410", async () => {
      const reg = await ctx.request("POST", "/auth/register", { body: { email: "dana@example.test", name: "Dana", password: "password123" } });
      const token = (await ctx.db.invitation.findFirstOrThrow({ where: { email: "dana@example.test" } })).token;
      ctx.clock.advance(INVITATION_TTL_MS + 1);
      const res = await ctx.request("POST", `/invitations/${token}/accept`, { as: { token: reg.body.token } });
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe("invitation_expired");
      ctx.clock.advance(-(INVITATION_TTL_MS + 1));
    });

    it("a person who became a member another way cannot accept again (409 already_member)", async () => {
      const invite = await ctx.request("POST", "/orgs/org_globex/invitations", { as: "otherAdmin", body: { email: "owner@acme.test", role: "admin" } });
      expect(invite.status).toBe(201);
      await ctx.db.membership.create({ data: { organizationId: "org_globex", userId: "u_owner", role: "member" } });
      const token = (await ctx.db.invitation.findUniqueOrThrow({ where: { id: invite.body.id } })).token;
      const res = await ctx.request("POST", `/invitations/${token}/accept`, { as: "owner" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("already_member");
    });
  });
});
