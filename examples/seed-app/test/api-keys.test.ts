import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers.js";

describe("API keys", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  let keyId = "";
  let secret = "";

  it("an admin creates a key; the secret is returned once and never listed", async () => {
    const res = await ctx.request("POST", "/orgs/org_acme/api-keys", { as: "admin", body: { name: "Reporting", role: "member" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ organizationId: "org_acme", name: "Reporting", role: "member", version: 1, createdById: "u_admin", revokedAt: null });
    expect(res.body.secret).toMatch(/^sk_/);
    expect(res.body.prefix).toBe(res.body.secret.slice(0, 11));
    expect(res.body.secretHash).toBeUndefined();
    keyId = res.body.id;
    secret = res.body.secret;

    const list = await ctx.request("GET", "/orgs/org_acme/api-keys", { as: "owner" });
    expect(list.status).toBe(200);
    const listed = list.body.data.find((k: { id: string }) => k.id === keyId);
    expect(listed).toBeDefined();
    expect(listed.secret).toBeUndefined();
    expect(listed.secretHash).toBeUndefined();
  });

  it("the key authenticates as an organization actor with its role", async () => {
    const res = await ctx.request("GET", "/orgs/org_acme", { as: { token: secret } });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("member");
    expect((await ctx.request("GET", "/orgs/org_acme/api-keys", { as: { token: secret } })).status).toBe(403);
    expect((await ctx.request("GET", "/orgs/org_globex", { as: { token: secret } })).status).toBe(403);
  });

  it("rotation returns a new secret, bumps the version, invalidates the old secret and emits ApiKeyRotated", async () => {
    const res = await ctx.request("POST", `/orgs/org_acme/api-keys/${keyId}/rotate`, { as: "owner" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: keyId, version: 2, rotatedAt: ctx.clock.now.toISOString() });
    expect(res.body.secret).toMatch(/^sk_/);
    expect(res.body.secret).not.toBe(secret);
    expect((await ctx.request("GET", "/orgs/org_acme", { as: { token: secret } })).status).toBe(401);
    expect((await ctx.request("GET", "/orgs/org_acme", { as: { token: res.body.secret } })).status).toBe(200);
    expect(ctx.events.sent.at(-1)).toMatchObject({ name: "averri/ApiKeyRotated", data: { apiKeyId: keyId, version: 2, rotatedBy: "u_owner" } });
    secret = res.body.secret;
  });

  it("members, other organizations and API keys themselves cannot manage keys", async () => {
    expect((await ctx.request("POST", "/orgs/org_acme/api-keys", { as: "member", body: { name: "x" } })).status).toBe(403);
    expect((await ctx.request("POST", `/orgs/org_acme/api-keys/${keyId}/rotate`, { as: "member" })).status).toBe(403);
    expect((await ctx.request("POST", `/orgs/org_globex/api-keys/${keyId}/rotate`, { as: "otherAdmin" })).status).toBe(404);
    const byAdminKey = await ctx.request("POST", `/orgs/org_acme/api-keys/${keyId}/rotate`, { as: { token: ctx.seed.apiKeys.acmeAdmin.secret } });
    expect(byAdminKey.status).toBe(403);
    expect(byAdminKey.body.error.code).toBe("user_required");
    expect((await ctx.request("POST", "/orgs/org_acme/api-keys", { as: "owner", body: { name: "x", role: "owner" } })).status).toBe(400);
  });

  it("revocation is idempotent, hides the key from the default list and stops authentication", async () => {
    const res = await ctx.request("DELETE", `/orgs/org_acme/api-keys/${keyId}`, { as: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.revokedAt).toBe(ctx.clock.now.toISOString());
    expect((await ctx.request("DELETE", `/orgs/org_acme/api-keys/${keyId}`, { as: "admin" })).status).toBe(200);
    expect((await ctx.request("GET", "/orgs/org_acme", { as: { token: secret } })).status).toBe(401);
    const rotate = await ctx.request("POST", `/orgs/org_acme/api-keys/${keyId}/rotate`, { as: "admin" });
    expect(rotate.status).toBe(409);
    expect(rotate.body.error.code).toBe("key_revoked");
    const active = await ctx.request("GET", "/orgs/org_acme/api-keys", { as: "admin" });
    expect(active.body.data.map((k: { id: string }) => k.id)).not.toContain(keyId);
    const all = await ctx.request("GET", "/orgs/org_acme/api-keys?includeRevoked=true", { as: "admin" });
    expect(all.body.data.map((k: { id: string }) => k.id)).toContain(keyId);
    const audit = await ctx.db.auditLog.findMany({ where: { targetId: keyId }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["api_key.created", "api_key.rotated", "api_key.revoked"]);
  });
});
