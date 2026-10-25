// @ts-nocheck — copied from examples/seed-app for @averri/compiler tests
/**
 * Authorization policies. `actor.id` is the user id for user tokens and the API key id for API keys,
 * which is why the organization policies accept either a membership row or a live API key.
 */
import { db, e, policy } from "@averri/core";

export const SignedInUser = policy("Auth.SignedInUser", {
  intent: "Any signed-in user; API keys are not people.",
  allow: db.exists("user", { id: e.actor("id") }),
});

export const OrgMember = policy("Org.Member", {
  intent: "Anyone inside the organization: a member of any role, or an organization API key.",
  allow: e.or(
    db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id") }),
    db.exists("apiKey", { id: e.actor("id"), organizationId: e.input("orgId"), revokedAt: null }),
  ),
});

export const OrgOwnerOrAdmin = policy("Org.OwnerOrAdmin", {
  intent: "Owners and admins manage membership, projects, keys and settings; members cannot.",
  allow: e.or(
    db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }),
    db.exists("apiKey", { id: e.actor("id"), organizationId: e.input("orgId"), role: "admin", revokedAt: null }),
  ),
});

export const OrgOwner = policy("Org.Owner", {
  intent: "Only owners delete the organization or start billing changes.",
  allow: db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: "owner" }),
});

export const OrgAdminOrSelf = policy("Org.AdminOrSelf", {
  intent: "Owners and admins act on any member; a member may act on their own membership (leave).",
  allow: e.or(
    db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }),
    e.and(db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id") }), e.eq("input.userId", e.actor("id"))),
  ),
});

export const policies = [SignedInUser, OrgMember, OrgOwnerOrAdmin, OrgOwner, OrgAdminOrSelf] as const;
