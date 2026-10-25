/**
 * Organizations (tenants). Creating one makes the creator its owner and opens a free subscription.
 * Deletion is soft (`deletedAt`); every tenant gate filters deleted organizations out.
 */
import { z } from "zod";
import type { UserActor } from "../auth.js";
import type { AppDeps } from "../context.js";
import { slugSchema } from "../lib/constants.js";
import { errors, isUniqueViolation } from "../lib/errors.js";
import { PAGE_ORDER, paginate, type PaginationQuery } from "../lib/pagination.js";
import { recordAudit } from "./audit.js";

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: slugSchema.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.slug !== undefined, { message: "Provide at least one field to update" });

export function serializeOrganization(org: { id: string; slug: string; name: string; createdAt: Date; updatedAt: Date }, role?: string) {
  return { id: org.id, slug: org.slug, name: org.name, createdAt: org.createdAt, updatedAt: org.updatedAt, ...(role === undefined ? {} : { role }) };
}

export async function createOrganization(deps: AppDeps, actor: UserActor, input: z.output<typeof createOrganizationSchema>) {
  try {
    const org = await deps.db.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name: input.name, slug: input.slug } });
      await tx.membership.create({ data: { organizationId: created.id, userId: actor.id, role: "owner" } });
      await tx.subscription.create({ data: { organizationId: created.id, plan: "free", status: "active", seats: 1 } });
      await recordAudit(tx, { organizationId: created.id, actor, action: "organization.created", targetType: "organization", targetId: created.id });
      return created;
    });
    return serializeOrganization(org, "owner");
  } catch (error) {
    if (isUniqueViolation(error)) throw errors.conflict("slug_taken", "An organization with this slug already exists");
    throw error;
  }
}

export async function listMyOrganizations(deps: AppDeps, actor: UserActor, query: PaginationQuery) {
  const page = await paginate(query, ({ take, cursor }) =>
    deps.db.organization.findMany({
      where: { deletedAt: null, memberships: { some: { userId: actor.id } }, ...(cursor ?? {}) },
      include: { memberships: { where: { userId: actor.id }, select: { role: true } } },
      orderBy: PAGE_ORDER,
      take,
    }),
  );
  return { data: page.data.map((org) => serializeOrganization(org, org.memberships[0]?.role)), nextCursor: page.nextCursor };
}

export async function getOrganization(deps: AppDeps, orgId: string, role: string) {
  const org = await deps.db.organization.findFirst({
    where: { id: orgId, deletedAt: null },
    include: { _count: { select: { memberships: true, projects: { where: { status: "active" } } } }, subscription: { select: { plan: true, status: true } } },
  });
  if (org === null) throw errors.notFound("Organization");
  return {
    ...serializeOrganization(org, role),
    memberCount: org._count.memberships,
    activeProjectCount: org._count.projects,
    plan: org.subscription?.plan ?? "free",
    subscriptionStatus: org.subscription?.status ?? "active",
  };
}

export async function updateOrganization(deps: AppDeps, actor: UserActor, orgId: string, input: z.output<typeof updateOrganizationSchema>) {
  try {
    const org = await deps.db.$transaction(async (tx) => {
      const updated = await tx.organization.update({
        where: { id: orgId },
        data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.slug === undefined ? {} : { slug: input.slug }) },
      });
      await recordAudit(tx, { organizationId: orgId, actor, action: "organization.updated", targetType: "organization", targetId: orgId, metadata: input });
      return updated;
    });
    return serializeOrganization(org);
  } catch (error) {
    if (isUniqueViolation(error)) throw errors.conflict("slug_taken", "An organization with this slug already exists");
    throw error;
  }
}

export async function deleteOrganization(deps: AppDeps, actor: UserActor, orgId: string): Promise<{ id: string; deletedAt: Date }> {
  const deletedAt = deps.now();
  await deps.db.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: orgId }, data: { deletedAt } });
    await tx.apiKey.updateMany({ where: { organizationId: orgId, revokedAt: null }, data: { revokedAt: deletedAt } });
    await tx.invitation.updateMany({ where: { organizationId: orgId, status: "pending" }, data: { status: "revoked", revokedAt: deletedAt } });
    await recordAudit(tx, { organizationId: orgId, actor, action: "organization.deleted", targetType: "organization", targetId: orgId });
  });
  return { id: orgId, deletedAt };
}
