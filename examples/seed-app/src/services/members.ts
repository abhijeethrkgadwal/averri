/**
 * Memberships: listing, role changes and removal, with the "never orphan an organization" rules:
 * an organization always keeps at least one owner; only owners grant or revoke the owner role;
 * admins manage members and other admins but never owners; anyone may leave unless they are the last owner.
 */
import { z } from "zod";
import { atLeast, type Actor, type OrgAccess } from "../auth.js";
import type { AppDeps } from "../context.js";
import type { Db } from "../db.js";
import { eventName } from "../events.js";
import { roleSchema, type Role } from "../lib/constants.js";
import { errors } from "../lib/errors.js";
import { PAGE_ORDER, paginate, type PaginationQuery } from "../lib/pagination.js";
import { recordAudit } from "./audit.js";

export const updateMemberRoleSchema = z.object({ role: roleSchema }).strict();

export function serializeMembership(m: {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  user?: { email: string; name: string };
}) {
  return {
    id: m.id,
    organizationId: m.organizationId,
    userId: m.userId,
    role: m.role,
    ...(m.user === undefined ? {} : { email: m.user.email, name: m.user.name }),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export async function listMembers(deps: AppDeps, orgId: string, query: PaginationQuery, filter: { role?: Role }) {
  const page = await paginate(query, ({ take, cursor }) =>
    deps.db.membership.findMany({
      where: { organizationId: orgId, ...(filter.role === undefined ? {} : { role: filter.role }), ...(cursor ?? {}) },
      include: { user: { select: { email: true, name: true } } },
      orderBy: PAGE_ORDER,
      take,
    }),
  );
  return { data: page.data.map(serializeMembership), nextCursor: page.nextCursor };
}

async function ownerCount(db: Db, orgId: string): Promise<number> {
  return db.membership.count({ where: { organizationId: orgId, role: "owner" } });
}

export async function updateMemberRole(deps: AppDeps, access: OrgAccess, targetUserId: string, input: z.output<typeof updateMemberRoleSchema>) {
  const actor = access.actor;
  const result = await deps.db.$transaction(async (tx) => {
    const target = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId: access.org.id, userId: targetUserId } },
      include: { user: { select: { email: true, name: true } } },
    });
    if (target === null) throw errors.notFound("Member");
    const current = target.role as Role;
    if (current === input.role) return { membership: target, changed: false };
    // Only owners touch the owner role, in either direction.
    if ((input.role === "owner" || current === "owner") && access.role !== "owner") {
      throw errors.forbidden("owner_required", "Only an owner can grant or revoke the owner role");
    }
    // Admins can act on members and admins only (the owner case is already excluded above).
    if (!atLeast(access.role, current)) {
      throw errors.forbidden("insufficient_role", "You cannot change the role of someone who outranks you");
    }
    if (current === "owner" && (await ownerCount(tx, access.org.id)) <= 1) {
      throw errors.conflict("last_owner", "An organization must keep at least one owner");
    }
    const membership = await tx.membership.update({
      where: { id: target.id },
      data: { role: input.role },
      include: { user: { select: { email: true, name: true } } },
    });
    await recordAudit(tx, {
      organizationId: access.org.id,
      actor,
      action: "member.role_changed",
      targetType: "membership",
      targetId: membership.id,
      metadata: { userId: targetUserId, from: current, to: input.role },
    });
    return { membership, changed: true, from: current };
  });
  if (result.changed) {
    await deps.events.send({
      name: eventName("MemberRoleChanged"),
      data: { organizationId: access.org.id, userId: targetUserId, from: result.from, to: input.role, changedBy: actor.id },
    });
  }
  return serializeMembership(result.membership);
}

export async function removeMember(deps: AppDeps, access: OrgAccess, targetUserId: string) {
  const actor: Actor = access.actor;
  const isSelf = actor.type === "user" && actor.id === targetUserId;
  // Authorization before lookup: a member removing anyone else is forbidden whether or not the target exists.
  if (!isSelf && !["owner", "admin"].includes(access.role)) {
    throw errors.forbidden("insufficient_role", "Only owners and admins remove other members");
  }
  const removed = await deps.db.$transaction(async (tx) => {
    const target = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId: access.org.id, userId: targetUserId } },
    });
    if (target === null) throw errors.notFound("Member");
    const targetRole = target.role as Role;
    if (!isSelf && targetRole === "owner" && access.role !== "owner") {
      throw errors.forbidden("owner_required", "Only an owner can remove another owner");
    }
    if (targetRole === "owner" && (await ownerCount(tx, access.org.id)) <= 1) {
      throw errors.conflict("last_owner", "An organization must keep at least one owner");
    }
    await tx.task.updateMany({ where: { organizationId: access.org.id, assigneeId: targetUserId }, data: { assigneeId: null } });
    await tx.membership.delete({ where: { id: target.id } });
    await recordAudit(tx, {
      organizationId: access.org.id,
      actor,
      action: isSelf ? "member.left" : "member.removed",
      targetType: "membership",
      targetId: target.id,
      metadata: { userId: targetUserId, role: targetRole },
    });
    return target;
  });
  await deps.events.send({
    name: eventName("MemberRemoved"),
    data: { organizationId: access.org.id, userId: targetUserId, role: removed.role, removedBy: actor.id, self: isSelf },
  });
  return { id: removed.id, organizationId: removed.organizationId, userId: removed.userId, role: removed.role, removed: true };
}
