/**
 * Users and sessions: registration, login (password → bearer token), logout, profile.
 */
import { z } from "zod";
import type { AppDeps } from "../context.js";
import { AUTH_TOKEN_TTL_MS, emailSchema } from "../lib/constants.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { errors, isUniqueViolation } from "../lib/errors.js";
import { USER_TOKEN_PREFIX, type UserActor } from "../auth.js";

export const registerSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export function serializeUser(user: { id: string; email: string; name: string; createdAt: Date; updatedAt: Date }) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

export async function issueToken(deps: AppDeps, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(USER_TOKEN_PREFIX);
  const expiresAt = new Date(deps.now().getTime() + AUTH_TOKEN_TTL_MS);
  await deps.db.authToken.create({ data: { tokenHash: sha256(token), userId, expiresAt } });
  return { token, expiresAt };
}

export async function register(deps: AppDeps, input: z.output<typeof registerSchema>) {
  let user;
  try {
    user = await deps.db.user.create({ data: { email: input.email, name: input.name, passwordHash: hashPassword(input.password) } });
  } catch (error) {
    if (isUniqueViolation(error)) throw errors.conflict("email_taken", "An account with this email already exists");
    throw error;
  }
  const session = await issueToken(deps, user.id);
  return { user: serializeUser(user), token: session.token, expiresAt: session.expiresAt };
}

export async function login(deps: AppDeps, input: z.output<typeof loginSchema>) {
  const user = await deps.db.user.findUnique({ where: { email: input.email } });
  // Same error for unknown email and wrong password so the endpoint does not reveal which emails exist.
  if (user === null || !verifyPassword(input.password, user.passwordHash)) {
    throw errors.unauthorized("Invalid email or password");
  }
  const session = await issueToken(deps, user.id);
  return { user: serializeUser(user), token: session.token, expiresAt: session.expiresAt };
}

export async function logout(deps: AppDeps, token: string): Promise<void> {
  await deps.db.authToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: deps.now() } });
}

export async function getProfile(deps: AppDeps, actor: UserActor) {
  const user = await deps.db.user.findUnique({
    where: { id: actor.id },
    include: { memberships: { include: { organization: { select: { id: true, slug: true, name: true, deletedAt: true } } } } },
  });
  if (user === null) throw errors.notFound("User");
  return {
    ...serializeUser(user),
    organizations: user.memberships
      .filter((m) => m.organization.deletedAt === null)
      .map((m) => ({ id: m.organization.id, slug: m.organization.slug, name: m.organization.name, role: m.role })),
  };
}

export async function updateProfile(deps: AppDeps, actor: UserActor, input: z.output<typeof updateProfileSchema>) {
  const user = await deps.db.user.update({ where: { id: actor.id }, data: { ...(input.name === undefined ? {} : { name: input.name }) } });
  return serializeUser(user);
}
