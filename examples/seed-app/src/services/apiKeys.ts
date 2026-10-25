/**
 * Organization API keys. The plaintext secret is returned exactly once (on create and on rotate);
 * the database holds its SHA-256 and a display prefix. Rotation keeps the key's identity and bumps
 * `version`; the previous secret stops working immediately.
 */
import { z } from "zod";
import { API_KEY_PREFIX, type OrgAccess } from "../auth.js";
import type { AppDeps } from "../context.js";
import { eventName } from "../events.js";
import { grantableRoleSchema } from "../lib/constants.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { errors } from "../lib/errors.js";
import { PAGE_ORDER, paginate, type PaginationQuery } from "../lib/pagination.js";
import { recordAudit } from "./audit.js";

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: grantableRoleSchema.default("member"),
});

export function serializeApiKey(key: {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  prefix: string;
  version: number;
  createdById: string;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: key.id,
    organizationId: key.organizationId,
    name: key.name,
    role: key.role,
    prefix: key.prefix,
    version: key.version,
    createdById: key.createdById,
    lastUsedAt: key.lastUsedAt,
    rotatedAt: key.rotatedAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

function newSecret(): { secret: string; prefix: string; secretHash: string } {
  const secret = randomToken(API_KEY_PREFIX);
  return { secret, prefix: secret.slice(0, 11), secretHash: sha256(secret) };
}

export async function createApiKey(deps: AppDeps, access: OrgAccess, input: z.output<typeof createApiKeySchema>) {
  const actor = access.actor;
  if (actor.type !== "user") throw errors.forbidden("user_required", "API keys cannot create API keys");
  const { secret, prefix, secretHash } = newSecret();
  const key = await deps.db.$transaction(async (tx) => {
    const created = await tx.apiKey.create({
      data: { organizationId: access.org.id, name: input.name, role: input.role, prefix, secretHash, createdById: actor.id },
    });
    await recordAudit(tx, { organizationId: access.org.id, actor, action: "api_key.created", targetType: "api_key", targetId: created.id, metadata: { role: input.role } });
    return created;
  });
  return { ...serializeApiKey(key), secret };
}

export async function listApiKeys(deps: AppDeps, orgId: string, query: PaginationQuery, filter: { includeRevoked: boolean }) {
  const page = await paginate(query, ({ take, cursor }) =>
    deps.db.apiKey.findMany({
      where: { organizationId: orgId, ...(filter.includeRevoked ? {} : { revokedAt: null }), ...(cursor ?? {}) },
      orderBy: PAGE_ORDER,
      take,
    }),
  );
  return { data: page.data.map(serializeApiKey), nextCursor: page.nextCursor };
}

export async function rotateApiKey(deps: AppDeps, access: OrgAccess, keyId: string) {
  const actor = access.actor;
  if (actor.type !== "user") throw errors.forbidden("user_required", "API keys cannot rotate API keys");
  const now = deps.now();
  const { secret, prefix, secretHash } = newSecret();
  const key = await deps.db.$transaction(async (tx) => {
    const existing = await tx.apiKey.findFirst({ where: { id: keyId, organizationId: access.org.id } });
    if (existing === null) throw errors.notFound("API key");
    if (existing.revokedAt !== null) throw errors.conflict("key_revoked", "A revoked API key cannot be rotated; create a new one");
    const rotated = await tx.apiKey.update({
      where: { id: existing.id },
      data: { prefix, secretHash, version: { increment: 1 }, rotatedAt: now },
    });
    await recordAudit(tx, { organizationId: access.org.id, actor, action: "api_key.rotated", targetType: "api_key", targetId: rotated.id, metadata: { version: rotated.version } });
    return rotated;
  });
  await deps.events.send({ name: eventName("ApiKeyRotated"), data: { apiKeyId: key.id, organizationId: key.organizationId, version: key.version, rotatedBy: actor.id } });
  return { ...serializeApiKey(key), secret };
}

export async function revokeApiKey(deps: AppDeps, access: OrgAccess, keyId: string) {
  const actor = access.actor;
  if (actor.type !== "user") throw errors.forbidden("user_required", "API keys cannot revoke API keys");
  const now = deps.now();
  const key = await deps.db.$transaction(async (tx) => {
    const existing = await tx.apiKey.findFirst({ where: { id: keyId, organizationId: access.org.id } });
    if (existing === null) throw errors.notFound("API key");
    if (existing.revokedAt !== null) return existing;
    const revoked = await tx.apiKey.update({ where: { id: existing.id }, data: { revokedAt: now } });
    await recordAudit(tx, { organizationId: access.org.id, actor, action: "api_key.revoked", targetType: "api_key", targetId: revoked.id });
    return revoked;
  });
  return serializeApiKey(key);
}
