// @ts-nocheck — copied from examples/seed-app for @averri/compiler tests
/**
 * Entity facts for the Prisma models (names MUST equal the model names, SPEC-DECLARATIONS §5.1).
 * Invariants are tier 1 only; bare paths refer to the row.
 */
import { e, entity } from "@averri/core";

export const User = entity("User", {
  intent: "A person who can sign in. Emails are stored lower-cased and are unique.",
  owner: "team-platform",
});

export const AuthToken = entity("AuthToken", {
  intent: "Bearer token for a user; only the SHA-256 hash is stored.",
  owner: "team-platform",
});

export const Organization = entity("Organization", {
  intent: "The tenant. Soft-deleted organizations keep their rows but reject every request.",
  owner: "team-platform",
});

export const Membership = entity("Membership", {
  intent: "Who belongs to an organization and with which role.",
  owner: "team-platform",
  invariant: {
    roleIsKnown: e.in("role", ["owner", "admin", "member"]),
  },
});

export const Invitation = entity("Invitation", {
  intent: "One invitation per organization and email; re-inviting a pending email resends it.",
  owner: "team-platform",
  invariant: {
    pendingHasNoAcceptedAt: e.or(e.ne("status", "pending"), e.isNull("acceptedAt")),
    acceptedHasAcceptor: e.or(e.ne("status", "accepted"), e.not(e.isNull("acceptedById"))),
    revokedHasTimestamp: e.or(e.ne("status", "revoked"), e.not(e.isNull("revokedAt"))),
    roleIsGrantable: e.in("role", ["admin", "member"]),
    resendCountNonNegative: e.gte("resendCount", 0),
  },
});

export const Project = entity("Project", {
  intent: "An organization-scoped container for tasks with a short unique key.",
  owner: "team-product",
  invariant: {
    archivedHasTimestamp: e.or(e.ne("status", "archived"), e.not(e.isNull("archivedAt"))),
    activeHasNoArchivedAt: e.or(e.ne("status", "active"), e.isNull("archivedAt")),
    taskCounterNonNegative: e.gte("taskCounter", 0),
  },
});

export const Task = entity("Task", {
  intent: "A numbered task inside a project; `completedAt` is set exactly when status is done.",
  owner: "team-product",
  invariant: {
    doneHasCompletedAt: e.or(e.ne("status", "done"), e.not(e.isNull("completedAt"))),
    openHasNoCompletedAt: e.or(e.eq("status", "done"), e.isNull("completedAt")),
    numberIsPositive: e.gte("number", 1),
    statusIsKnown: e.in("status", ["todo", "in_progress", "done"]),
  },
});

export const ApiKey = entity("ApiKey", {
  intent: "Organization API key; the secret is shown once and rotation bumps `version`.",
  owner: "team-platform",
  invariant: {
    versionIsPositive: e.gte("version", 1),
    roleIsGrantable: e.in("role", ["admin", "member"]),
  },
});

export const Subscription = entity("Subscription", {
  intent: "Billing state mirrored from Stripe webhooks; one row per organization.",
  owner: "team-billing",
  invariant: {
    seatsArePositive: e.gte("seats", 1),
    planIsKnown: e.in("plan", ["free", "pro", "enterprise"]),
    statusIsKnown: e.in("status", ["active", "trialing", "past_due", "canceled", "incomplete"]),
  },
});

export const WebhookEvent = entity("WebhookEvent", {
  intent: "Every accepted webhook delivery, unique per provider event id (idempotency).",
  owner: "team-billing",
  invariant: {
    statusIsKnown: e.in("status", ["processed", "ignored", "failed"]),
  },
});

export const AuditLog = entity("AuditLog", {
  intent: "Append-only record of who did what inside an organization.",
  owner: "team-platform",
});

export const entities = [User, AuthToken, Organization, Membership, Invitation, Project, Task, ApiKey, Subscription, WebhookEvent, AuditLog] as const;
