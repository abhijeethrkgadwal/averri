import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_TOKEN_TTL_MS } from "../src/lib/constants.js";
import { createTestContext, type TestContext } from "./helpers.js";

describe("auth: register, login, logout, profile, token kinds", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("registers a user, lower-cases the email and returns a usable bearer token", async () => {
    const res = await ctx.request("POST", "/auth/register", { body: { email: "New.Person@Example.test", name: "New Person", password: "correct horse" } });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "new.person@example.test", name: "New Person" });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.token).toMatch(/^usr_/);

    const me = await ctx.request("GET", "/me", { as: { token: res.body.token } });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("new.person@example.test");
    expect(me.body.organizations).toEqual([]);
  });

  it("rejects duplicate emails with 409 and bad payloads with 400", async () => {
    const dup = await ctx.request("POST", "/auth/register", { body: { email: "owner@acme.test", name: "Dup", password: "correct horse" } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("email_taken");

    const bad = await ctx.request("POST", "/auth/register", { body: { email: "not-an-email", name: "", password: "short" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation_failed");
    const paths = bad.body.error.details.issues.map((i: { path: string }) => i.path).sort();
    expect(paths).toEqual(["email", "name", "password"]);

    const malformed = await ctx.request("POST", "/auth/register", { rawBody: "{not json", headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("malformed_json");
  });

  it("logs in with the seed password and fails with the same error for unknown email or wrong password", async () => {
    const ok = await ctx.request("POST", "/auth/login", { body: { email: "OWNER@acme.test", password: "password123" } });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe("u_owner");

    const wrongPassword = await ctx.request("POST", "/auth/login", { body: { email: "owner@acme.test", password: "nope-nope-nope" } });
    const unknownEmail = await ctx.request("POST", "/auth/login", { body: { email: "ghost@acme.test", password: "password123" } });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("logout revokes the token used for the call", async () => {
    const login = await ctx.request("POST", "/auth/login", { body: { email: "member@acme.test", password: "password123" } });
    const token = login.body.token as string;
    expect((await ctx.request("GET", "/me", { as: { token } })).status).toBe(200);
    expect((await ctx.request("POST", "/auth/logout", { as: { token } })).status).toBe(200);
    expect((await ctx.request("GET", "/me", { as: { token } })).status).toBe(401);
    // The seed token of the same user is unaffected.
    expect((await ctx.request("GET", "/me", { as: "member" })).status).toBe(200);
  });

  it("expired tokens are anonymous", async () => {
    const login = await ctx.request("POST", "/auth/login", { body: { email: "admin@acme.test", password: "password123" } });
    const token = login.body.token as string;
    ctx.clock.advance(AUTH_TOKEN_TTL_MS + 1000);
    const me = await ctx.request("GET", "/me", { as: { token } });
    expect(me.status).toBe(401);
    ctx.clock.advance(-(AUTH_TOKEN_TTL_MS + 1000));
  });

  it("malformed and unknown bearer tokens are anonymous, not errors", async () => {
    expect((await ctx.request("GET", "/me", { headers: { authorization: "Basic abc" } })).status).toBe(401);
    expect((await ctx.request("GET", "/me", { headers: { authorization: "Bearer usr_does_not_exist" } })).status).toBe(401);
    expect((await ctx.request("GET", "/me", { headers: { authorization: "Bearer sk_does_not_exist" } })).status).toBe(401);
  });

  it("/me lists the user's organizations with roles and PATCH /me updates the name", async () => {
    const me = await ctx.request("GET", "/me", { as: "owner" });
    expect(me.body.organizations).toEqual([{ id: "org_acme", slug: "acme", name: "Acme Inc", role: "owner" }]);
    const patched = await ctx.request("PATCH", "/me", { as: "owner", body: { name: "Olivia O." } });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Olivia O.");
    const strict = await ctx.request("PATCH", "/me", { as: "owner", body: { email: "x@y.z" } });
    expect(strict.status).toBe(400);
  });

  it("API keys authenticate as an organization actor but cannot use user-only endpoints", async () => {
    const key = { token: ctx.seed.apiKeys.acmeMember.secret };
    const org = await ctx.request("GET", "/orgs/org_acme", { as: key });
    expect(org.status).toBe(200);
    expect(org.body.role).toBe("member");
    const me = await ctx.request("GET", "/me", { as: key });
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe("user_required");
    const used = await ctx.db.apiKey.findUniqueOrThrow({ where: { id: ctx.seed.apiKeys.acmeMember.id } });
    expect(used.lastUsedAt).not.toBeNull();
  });
});
