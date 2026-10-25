/**
 * Authorization policies. `actor.id` is the user id for user tokens and the API key id for API keys,
 * so every predicate is guarded by `actor.type`: the app resolves an API key's role from the key row
 * (never from a membership) and a user's role from the membership row (never from a key).
 */
import { db, e, policy } from "@averri/core";

const isUser = e.eq("actor.type", "user");
const isApiKey = e.eq("actor.type", "apiKey");

export const SignedInUser = policy("Auth.SignedInUser", {
  intent: "Any signed-in user; API keys are not people.",
  allow: e.and(isUser, db.exists("user", { id: e.actor("id") })),
});

export const OrgMember = policy("Org.Member", {
  intent: "Anyone inside the organization: a member of any role, or an organization API key.",
  allow: e.or(
    e.and(isUser, db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), organization: { deletedAt: null } })),
    e.and(isApiKey, db.exists("apiKey", { id: e.actor("id"), organizationId: e.input("orgId"), revokedAt: null, organization: { deletedAt: null } })),
  ),
});

export const OrgOwnerOrAdmin = policy("Org.OwnerOrAdmin", {
  intent: "Owners and admins manage membership, projects, keys and settings; members cannot.",
  allow: e.or(
    e.and(isUser, db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: { in: ["owner", "admin"] }, organization: { deletedAt: null } })),
    e.and(isApiKey, db.exists("apiKey", { id: e.actor("id"), organizationId: e.input("orgId"), role: "admin", revokedAt: null, organization: { deletedAt: null } })),
  ),
});

export const OrgOwnerOrAdminUser = policy("Org.OwnerOrAdminUser", {
  intent: "Owners and admins acting as themselves; API keys cannot invite people or manage keys.",
  allow: e.and(isUser, db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: { in: ["owner", "admin"] }, organization: { deletedAt: null } })),
});

export const OrgOwner = policy("Org.Owner", {
  intent: "Only owners delete the organization or start billing changes.",
  allow: e.and(isUser, db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: "owner", organization: { deletedAt: null } })),
});

export const OrgAdminOrSelf = policy("Org.AdminOrSelf", {
  intent: "Owners and admins act on any member; a member may act on their own membership (leave).",
  allow: e.or(
    e.and(isUser, db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: { in: ["owner", "admin"] }, organization: { deletedAt: null } })),
    e.and(isApiKey, db.exists("apiKey", { id: e.actor("id"), organizationId: e.input("orgId"), role: "admin", revokedAt: null, organization: { deletedAt: null } })),
    e.and(isUser, db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), organization: { deletedAt: null } }), e.eq("input.userId", e.actor("id"))),
  ),
});

export const policies = [SignedInUser, OrgMember, OrgOwnerOrAdmin, OrgOwnerOrAdminUser, OrgOwner, OrgAdminOrSelf] as const;
