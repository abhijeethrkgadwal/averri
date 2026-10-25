/**
 * Bearer-token authentication and tenant authorization.
 *
 * `Authorization: Bearer <token>` resolves to an `Actor`:
 * - `usr_...` tokens come from `POST /auth/login` (table `AuthToken`) and identify a user;
 * - `sk_...`  tokens are organization API keys (table `ApiKey`) and act for one organization with the key's role.
 *
 * `auth` runs on every request and only RESOLVES the actor (anonymous is `null`); `requireUser` and
 * `requireOrgRole` are the enforcement helpers the handlers call. Averri's config lists both names under
 * `authMiddleware` so undeclared routes without them are flagged (A2103).
 */
import type { MiddlewareHandler } from "hono";
import { ROLE_RANK, type Role } from "./lib/constants.js";
import { sha256 } from "./lib/crypto.js";
import { errors } from "./lib/errors.js";
import type { AppContext, AppDeps, AppEnv } from "./context.js";
import type { Db } from "./db.js";

export type UserActor = { type: "user"; id: string; email: string; name: string };
export type ApiKeyActor = { type: "apiKey"; id: string; orgId: string; role: Exclude<Role, "owner">; name: string };
export type Actor = UserActor | ApiKeyActor;

export const USER_TOKEN_PREFIX = "usr";
export const API_KEY_PREFIX = "sk";

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Resolve a bearer token to an actor; unknown, expired or revoked tokens resolve to `null`. */
export async function resolveActor(db: Db, token: string | null, now: Date): Promise<Actor | null> {
  if (token === null) return null;
  const hash = sha256(token);
  if (token.startsWith(`${API_KEY_PREFIX}_`)) {
    const key = await db.apiKey.findUnique({ where: { secretHash: hash }, include: { organization: { select: { deletedAt: true } } } });
    if (key === null || key.revokedAt !== null || key.organization.deletedAt !== null) return null;
    const role = key.role === "admin" ? "admin" : "member";
    await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } }).catch(() => undefined);
    return { type: "apiKey", id: key.id, orgId: key.organizationId, role, name: key.name };
  }
  const authToken = await db.authToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
  if (authToken === null || authToken.revokedAt !== null || authToken.expiresAt.getTime() <= now.getTime()) return null;
  return { type: "user", id: authToken.userId, email: authToken.user.email, name: authToken.user.name };
}

/** Middleware: resolves the actor for every request (never rejects). */
export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get("deps");
  const actor = await resolveActor(deps.db, bearerToken(c.req.header("authorization")), deps.now());
  c.set("actor", actor);
  await next();
};

/** The signed-in user, or 401. API keys are rejected where a person is required. */
export function requireUser(c: AppContext): UserActor {
  const actor = c.get("actor");
  if (actor === null) throw errors.unauthorized();
  if (actor.type !== "user") throw errors.forbidden("user_required", "This endpoint requires a user token, not an API key");
  return actor;
}

/** Any authenticated actor (user or API key), or 401. */
export function requireActor(c: AppContext): Actor {
  const actor = c.get("actor");
  if (actor === null) throw errors.unauthorized();
  return actor;
}

export interface OrgAccess {
  org: { id: string; slug: string; name: string };
  /** The actor's effective role inside the organization. */
  role: Role;
  actor: Actor;
}

/**
 * Tenant gate: the organization must exist (not soft-deleted) and the actor must hold one of `roles` in it.
 * Non-members get 403 (`not_a_member`), members with a lesser role 403 (`insufficient_role`).
 */
export async function requireOrgRole(deps: AppDeps, actor: Actor | null, orgId: string, roles: readonly Role[]): Promise<OrgAccess> {
  if (actor === null) throw errors.unauthorized();
  const org = await deps.db.organization.findFirst({ where: { id: orgId, deletedAt: null }, select: { id: true, slug: true, name: true } });
  if (org === null) throw errors.notFound("Organization");
  let role: Role | null = null;
  if (actor.type === "apiKey") {
    role = actor.orgId === org.id ? actor.role : null;
  } else {
    const membership = await deps.db.membership.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: actor.id } },
      select: { role: true },
    });
    role = membership === null ? null : (membership.role as Role);
  }
  if (role === null) throw errors.forbidden("not_a_member", "You are not a member of this organization");
  if (!roles.includes(role)) throw errors.forbidden("insufficient_role", `This action requires one of: ${roles.join(", ")}`);
  return { org, role, actor };
}

export function outranks(a: Role, b: Role): boolean {
  return ROLE_RANK[a] > ROLE_RANK[b];
}

export function atLeast(a: Role, b: Role): boolean {
  return ROLE_RANK[a] >= ROLE_RANK[b];
}
