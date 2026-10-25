/**
 * The authorization matrix: every protected route against every fixture actor. Mirrors what Averri's
 * generated `auth-matrix` suite will assert against the declared policies (anonymous → 401,
 * denied → 403, allowed → 2xx/4xx-but-not-auth).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type RequestOptions, type TestContext } from "./helpers.js";

type Fixture = "anonymous" | "member" | "admin" | "owner" | "otherAdmin" | "outsider" | "apiKeyMember" | "apiKeyAdmin";
/** Least privileged first, owner last: the final case really deletes the organization. */
const FIXTURES: Fixture[] = ["anonymous", "outsider", "otherAdmin", "apiKeyMember", "apiKeyAdmin", "member", "admin", "owner"];

/**
 * Expected outcome per fixture. "allow" means the request passed authentication and authorization:
 * any status except 401, and except a 403 carrying one of the authorization error codes below
 * (a 403 `email_mismatch` on invitation acceptance is a business rule, not an access decision).
 */
type Expectation = "401" | "403" | "allow";
const AUTH_DENIAL_CODES = new Set(["unauthenticated", "forbidden", "not_a_member", "insufficient_role", "user_required", "owner_required"]);

interface RouteCase {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  expect: Record<Fixture, Expectation>;
}

const ALL_MEMBERS: Record<Fixture, Expectation> = {
  anonymous: "401",
  member: "allow",
  admin: "allow",
  owner: "allow",
  otherAdmin: "403",
  outsider: "403",
  apiKeyMember: "allow",
  apiKeyAdmin: "allow",
};
const ADMINS: Record<Fixture, Expectation> = { ...ALL_MEMBERS, member: "403", apiKeyMember: "403" };
const ADMIN_USERS_ONLY: Record<Fixture, Expectation> = { ...ADMINS, apiKeyAdmin: "403" };
const OWNER_ONLY: Record<Fixture, Expectation> = { ...ADMIN_USERS_ONLY, admin: "403" };
const SIGNED_IN_USERS: Record<Fixture, Expectation> = {
  anonymous: "401",
  member: "allow",
  admin: "allow",
  owner: "allow",
  otherAdmin: "allow",
  outsider: "allow",
  apiKeyMember: "403",
  apiKeyAdmin: "403",
};

const CASES: RouteCase[] = [
  { name: "GET /me", method: "GET", path: "/me", expect: SIGNED_IN_USERS },
  { name: "POST /orgs", method: "POST", path: "/orgs", body: { name: "X", slug: "x-org-{{i}}" }, expect: SIGNED_IN_USERS },
  { name: "GET /orgs/:orgId", method: "GET", path: "/orgs/org_acme", expect: ALL_MEMBERS },
  { name: "PATCH /orgs/:orgId", method: "PATCH", path: "/orgs/org_acme", body: { name: "Acme" }, expect: ADMIN_USERS_ONLY },
  { name: "GET /orgs/:orgId/members", method: "GET", path: "/orgs/org_acme/members", expect: ALL_MEMBERS },
  { name: "PATCH /orgs/:orgId/members/:userId", method: "PATCH", path: "/orgs/org_acme/members/u_member", body: { role: "member" }, expect: ADMINS },
  { name: "DELETE /orgs/:orgId/members/:userId (other)", method: "DELETE", path: "/orgs/org_acme/members/u_ghost", expect: { ...ADMINS, member: "403", apiKeyMember: "403" } },
  { name: "POST /orgs/:orgId/invitations", method: "POST", path: "/orgs/org_acme/invitations", body: { email: "m{{i}}@example.test", role: "member" }, expect: ADMIN_USERS_ONLY },
  { name: "GET /orgs/:orgId/invitations", method: "GET", path: "/orgs/org_acme/invitations", expect: ADMINS },
  { name: "POST /orgs/:orgId/invitations/:id/resend", method: "POST", path: "/orgs/org_acme/invitations/inv_pending/resend", expect: ADMINS },
  { name: "DELETE /orgs/:orgId/invitations/:id", method: "DELETE", path: "/orgs/org_acme/invitations/inv_nope", expect: ADMINS },
  { name: "POST /invitations/:token/accept", method: "POST", path: "/invitations/inv_seed_pending_token/accept", expect: SIGNED_IN_USERS },
  { name: "POST /orgs/:orgId/projects", method: "POST", path: "/orgs/org_acme/projects", body: { name: "Matrix {{i}}", key: "MX{{i}}" }, expect: ADMINS },
  { name: "GET /orgs/:orgId/projects", method: "GET", path: "/orgs/org_acme/projects", expect: ALL_MEMBERS },
  { name: "GET /orgs/:orgId/projects/:id", method: "GET", path: "/orgs/org_acme/projects/proj_website", expect: ALL_MEMBERS },
  { name: "PATCH /orgs/:orgId/projects/:id", method: "PATCH", path: "/orgs/org_acme/projects/proj_website", body: { name: "Website relaunch" }, expect: ADMINS },
  { name: "POST /orgs/:orgId/projects/:id/archive", method: "POST", path: "/orgs/org_acme/projects/proj_nope/archive", expect: ADMINS },
  { name: "POST /orgs/:orgId/projects/:id/tasks", method: "POST", path: "/orgs/org_acme/projects/proj_website/tasks", body: { title: "t" }, expect: ALL_MEMBERS },
  { name: "GET /orgs/:orgId/projects/:id/tasks", method: "GET", path: "/orgs/org_acme/projects/proj_website/tasks", expect: ALL_MEMBERS },
  { name: "GET /orgs/:orgId/tasks/:id", method: "GET", path: "/orgs/org_acme/tasks/task_web_2", expect: ALL_MEMBERS },
  { name: "PATCH /orgs/:orgId/tasks/:id", method: "PATCH", path: "/orgs/org_acme/tasks/task_web_2", body: { priority: "low" }, expect: ALL_MEMBERS },
  { name: "DELETE /orgs/:orgId/tasks/:id", method: "DELETE", path: "/orgs/org_acme/tasks/task_nope", expect: ADMINS },
  { name: "POST /orgs/:orgId/api-keys", method: "POST", path: "/orgs/org_acme/api-keys", body: { name: "k" }, expect: ADMIN_USERS_ONLY },
  { name: "GET /orgs/:orgId/api-keys", method: "GET", path: "/orgs/org_acme/api-keys", expect: ADMINS },
  { name: "POST /orgs/:orgId/api-keys/:id/rotate", method: "POST", path: "/orgs/org_acme/api-keys/key_nope/rotate", expect: ADMIN_USERS_ONLY },
  { name: "DELETE /orgs/:orgId/api-keys/:id", method: "DELETE", path: "/orgs/org_acme/api-keys/key_nope", expect: ADMIN_USERS_ONLY },
  { name: "GET /orgs/:orgId/billing", method: "GET", path: "/orgs/org_acme/billing", expect: ADMINS },
  { name: "POST /orgs/:orgId/billing/checkout", method: "POST", path: "/orgs/org_acme/billing/checkout", body: { plan: "pro" }, expect: OWNER_ONLY },
  { name: "GET /orgs/:orgId/audit-log", method: "GET", path: "/orgs/org_acme/audit-log", expect: ADMINS },
  // Last on purpose: the owner really deletes the organization.
  { name: "DELETE /orgs/:orgId", method: "DELETE", path: "/orgs/org_acme", expect: OWNER_ONLY },
];

describe("authorization matrix", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  function asOption(fixture: Fixture): RequestOptions["as"] {
    switch (fixture) {
      case "anonymous":
        return null;
      case "apiKeyMember":
        return { token: ctx.seed.apiKeys.acmeMember.secret };
      case "apiKeyAdmin":
        return { token: ctx.seed.apiKeys.acmeAdmin.secret };
      default:
        return fixture;
    }
  }

  let counter = 0;
  for (const route of CASES) {
    it(route.name, async () => {
      const observed: Record<string, number> = {};
      const failures: string[] = [];
      for (const fixture of FIXTURES) {
        counter += 1;
        const body = route.body === undefined ? undefined : JSON.parse(JSON.stringify(route.body).replace(/\{\{i\}\}/g, String(counter)));
        const res = await ctx.request(route.method, route.path, { as: asOption(fixture), body });
        observed[fixture] = res.status;
        const expected = route.expect[fixture];
        const code = typeof res.body === "object" && res.body !== null ? (res.body.error?.code as string | undefined) : undefined;
        const authDenied = res.status === 401 || (res.status === 403 && code !== undefined && AUTH_DENIAL_CODES.has(code));
        const ok = expected === "allow" ? !authDenied : res.status === Number(expected) && authDenied;
        if (!ok) failures.push(`${fixture}: expected ${expected}, got ${res.status} ${JSON.stringify(res.body)}`);
      }
      expect(failures, JSON.stringify(observed)).toEqual([]);
    });
  }

  it("the matrix covers every registered non-public route", () => {
    const registered = new Set(ctx.app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));
    const PUBLIC = new Set(["GET /health", "POST /auth/register", "POST /auth/login", "GET /invitations/:token", "POST /webhooks/stripe"]);
    const covered = new Set(
      CASES.map((c) => `${c.method} ${c.path}`)
        .map((s) =>
          s
            .replace(/\/orgs\/org_acme/, "/orgs/:orgId")
            .replace(/\/members\/u_\w+/, "/members/:userId")
            .replace(/\/invitations\/inv_\w+\/accept/, "/invitations/:token/accept")
            .replace(/\/invitations\/inv_\w+/, "/invitations/:invitationId")
            .replace(/\/projects\/proj_\w+/, "/projects/:projectId")
            .replace(/\/tasks\/task_\w+/, "/tasks/:taskId")
            .replace(/\/api-keys\/key_\w+/, "/api-keys/:keyId"),
        ),
    );
    covered.add("POST /auth/logout");
    covered.add("PATCH /me");
    covered.add("GET /orgs");
    const missing = [...registered].filter((r) => !PUBLIC.has(r) && !covered.has(r));
    expect(missing).toEqual([]);
    expect(registered.size).toBeGreaterThanOrEqual(35);
  });
});
