/**
 * Invitations: invite (upsert per organization+email; re-inviting a pending email resends), resend,
 * revoke, public preview by token, and acceptance by the signed-in user whose email matches.
 */
import { z } from "zod";
import type { OrgAccess, UserActor } from "../auth.js";
import type { AppDeps } from "../context.js";
import { eventName } from "../events.js";
import { emailSchema, grantableRoleSchema, INVITATION_TTL_MS, invitationStatusSchema } from "../lib/constants.js";
import { randomToken } from "../lib/crypto.js";
import { errors, isUniqueViolation } from "../lib/errors.js";
import { PAGE_ORDER, paginate, type PaginationQuery } from "../lib/pagination.js";
import { recordAudit } from "./audit.js";

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: grantableRoleSchema,
});

export const listInvitationsQuerySchema = z.object({ status: invitationStatusSchema.optional() });

export function serializeInvitation(inv: {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  invitedById: string;
  acceptedById: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  resentAt: Date | null;
  resendCount: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: inv.id,
    organizationId: inv.organizationId,
    email: inv.email,
    role: inv.role,
    status: inv.status,
    invitedById: inv.invitedById,
    acceptedById: inv.acceptedById,
    acceptedAt: inv.acceptedAt,
    revokedAt: inv.revokedAt,
    resentAt: inv.resentAt,
    resendCount: inv.resendCount,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

/** Pending invitations past `expiresAt` read as `expired`; nothing else changes. */
export function effectiveStatus(inv: { status: string; expiresAt: Date }, now: Date): string {
  return inv.status === "pending" && inv.expiresAt.getTime() <= now.getTime() ? "expired" : inv.status;
}

export async function inviteMember(deps: AppDeps, access: OrgAccess, input: z.output<typeof inviteMemberSchema>) {
  const actor = access.actor;
  if (actor.type !== "user") throw errors.forbidden("user_required", "API keys cannot invite members");
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const invitation = await deps.db.$transaction(async (tx) => {
    const existingMember = await tx.membership.findFirst({ where: { organizationId: access.org.id, user: { email: input.email } } });
    if (existingMember !== null) throw errors.conflict("already_member", "This person is already a member of the organization");
    const existing = await tx.invitation.findUnique({ where: { organizationId_email: { organizationId: access.org.id, email: input.email } } });
    let row;
    if (existing === null) {
      row = await tx.invitation.create({
        data: { organizationId: access.org.id, email: input.email, role: input.role, invitedById: actor.id, status: "pending", token: randomToken("inv"), expiresAt },
      });
    } else {
      const wasPending = effectiveStatus(existing, now) === "pending";
      row = await tx.invitation.update({
        where: { id: existing.id },
        data: {
          role: input.role,
          status: "pending",
          invitedById: actor.id,
          expiresAt,
          acceptedAt: null,
          acceptedById: null,
          revokedAt: null,
          // A pending invitation is resent with the same token; a revoked/expired/accepted one is reissued.
          ...(wasPending ? { resentAt: now, resendCount: { increment: 1 } } : { token: randomToken("inv"), resentAt: null, resendCount: 0 }),
        },
      });
    }
    await recordAudit(tx, {
      organizationId: access.org.id,
      actor,
      action: existing === null ? "invitation.created" : "invitation.resent",
      targetType: "invitation",
      targetId: row.id,
      metadata: { email: input.email, role: input.role },
    });
    return row;
  });
  await deps.events.send({
    name: eventName("MemberInvited"),
    data: { invitationId: invitation.id, organizationId: invitation.organizationId, email: invitation.email, token: invitation.token },
  });
  return serializeInvitation(invitation);
}

export async function listInvitations(deps: AppDeps, orgId: string, query: PaginationQuery, filter: { status?: string }) {
  const now = deps.now();
  const page = await paginate(query, ({ take, cursor }) =>
    deps.db.invitation.findMany({
      where: {
        organizationId: orgId,
        ...(filter.status === undefined ? {} : filter.status === "expired" ? { status: "pending", expiresAt: { lte: now } } : filter.status === "pending" ? { status: "pending", expiresAt: { gt: now } } : { status: filter.status }),
        ...(cursor ?? {}),
      },
      orderBy: PAGE_ORDER,
      take,
    }),
  );
  return { data: page.data.map((inv) => ({ ...serializeInvitation(inv), status: effectiveStatus(inv, now) })), nextCursor: page.nextCursor };
}

export async function resendInvitation(deps: AppDeps, access: OrgAccess, invitationId: string) {
  const now = deps.now();
  const invitation = await deps.db.$transaction(async (tx) => {
    const existing = await tx.invitation.findFirst({ where: { id: invitationId, organizationId: access.org.id } });
    if (existing === null) throw errors.notFound("Invitation");
    if (existing.status !== "pending") throw errors.conflict("not_pending", `Only pending invitations can be resent (status: ${existing.status})`);
    const row = await tx.invitation.update({
      where: { id: existing.id },
      data: { resentAt: now, resendCount: { increment: 1 }, expiresAt: new Date(now.getTime() + INVITATION_TTL_MS) },
    });
    await recordAudit(tx, { organizationId: access.org.id, actor: access.actor, action: "invitation.resent", targetType: "invitation", targetId: row.id });
    return row;
  });
  await deps.events.send({
    name: eventName("MemberInvited"),
    data: { invitationId: invitation.id, organizationId: invitation.organizationId, email: invitation.email, token: invitation.token },
  });
  return serializeInvitation(invitation);
}

export async function revokeInvitation(deps: AppDeps, access: OrgAccess, invitationId: string) {
  const now = deps.now();
  const invitation = await deps.db.$transaction(async (tx) => {
    const existing = await tx.invitation.findFirst({ where: { id: invitationId, organizationId: access.org.id } });
    if (existing === null) throw errors.notFound("Invitation");
    if (existing.status !== "pending") throw errors.conflict("not_pending", `Only pending invitations can be revoked (status: ${existing.status})`);
    const row = await tx.invitation.update({ where: { id: existing.id }, data: { status: "revoked", revokedAt: now } });
    await recordAudit(tx, { organizationId: access.org.id, actor: access.actor, action: "invitation.revoked", targetType: "invitation", targetId: row.id });
    return row;
  });
  return serializeInvitation(invitation);
}

/** Public preview for the invitation landing page: no emails of other people, no ids beyond the organization name. */
export async function previewInvitation(deps: AppDeps, token: string) {
  const invitation = await deps.db.invitation.findUnique({
    where: { token },
    include: { organization: { select: { name: true, deletedAt: true } }, invitedBy: { select: { name: true } } },
  });
  if (invitation === null || invitation.organization.deletedAt !== null) throw errors.notFound("Invitation");
  return {
    organizationName: invitation.organization.name,
    invitedBy: invitation.invitedBy.name,
    email: invitation.email,
    role: invitation.role,
    status: effectiveStatus(invitation, deps.now()),
    expiresAt: invitation.expiresAt,
  };
}

export async function acceptInvitation(deps: AppDeps, actor: UserActor, token: string) {
  const now = deps.now();
  const accepted = await deps.db.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({ where: { token }, include: { organization: { select: { id: true, name: true, slug: true, deletedAt: true } } } });
    if (invitation === null || invitation.organization.deletedAt !== null) throw errors.notFound("Invitation");
    const status = effectiveStatus(invitation, now);
    if (status === "expired") throw errors.gone("invitation_expired", "This invitation has expired; ask for a new one");
    if (status !== "pending") throw errors.conflict("not_pending", `This invitation is ${status}`);
    if (invitation.email !== actor.email) {
      throw errors.forbidden("email_mismatch", "This invitation was sent to a different email address");
    }
    let membership;
    try {
      membership = await tx.membership.create({ data: { organizationId: invitation.organizationId, userId: actor.id, role: invitation.role } });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict("already_member", "You are already a member of this organization");
      throw error;
    }
    const updated = await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "accepted", acceptedAt: now, acceptedById: actor.id },
    });
    await recordAudit(tx, {
      organizationId: invitation.organizationId,
      actor,
      action: "invitation.accepted",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { membershipId: membership.id, role: invitation.role },
    });
    return { invitation: updated, membership, organization: invitation.organization };
  });
  await deps.events.send({
    name: eventName("InvitationAccepted"),
    data: { invitationId: accepted.invitation.id, organizationId: accepted.invitation.organizationId, userId: actor.id, role: accepted.membership.role },
  });
  return {
    invitation: serializeInvitation(accepted.invitation),
    membership: { id: accepted.membership.id, organizationId: accepted.membership.organizationId, userId: accepted.membership.userId, role: accepted.membership.role },
    organization: { id: accepted.organization.id, slug: accepted.organization.slug, name: accepted.organization.name },
  };
}
