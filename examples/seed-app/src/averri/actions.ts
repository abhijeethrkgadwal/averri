/**
 * Observe-mode action declarations: no `run`, every route matches a registration in `src/routes`,
 * `input` is `{ ...body, ...params }` as the observe adapter builds it (path params win).
 * Contracts are evaluated only under Vitest through `observe()`; nothing here runs in production.
 */
import { action, db, e } from "@averri/core";
import { z } from "zod";
import { emailSchema, grantableRoleSchema, idSchema, projectKeySchema, roleSchema, slugSchema, taskPrioritySchema } from "../lib/constants.js";
import { stripeEventSchema } from "../services/billing.js";
import { ApiKey, Invitation, Membership, Project, Task } from "./entities.js";
import { ApiKeyRotated, InvitationAccepted, MemberInvited, MemberRemoved, MemberRoleChanged, ProjectCreated, TaskCreated } from "./events.js";
import { OrgAdminOrSelf, OrgOwnerOrAdmin, OrgOwnerOrAdminUser, OrgMember, SignedInUser } from "./policies.js";
// handler: the service function behind each route (feeds effect-scan; never called by Averri)
import { createApiKey, rotateApiKey } from "../services/apiKeys.js";
import { handleStripeWebhook } from "../services/billing.js";
import { acceptInvitation, inviteMember, revokeInvitation } from "../services/invitations.js";
import { removeMember, updateMemberRole } from "../services/members.js";
import { createOrganization } from "../services/organizations.js";
import { archiveProject, createProject } from "../services/projects.js";
import { createTask } from "../services/tasks.js";

// --- organizations ---------------------------------------------------------

export const CreateOrganization = action("Org.createOrganization", {
  intent: "A signed-in user creates an organization, becomes its first owner and gets a free subscription.",
  route: { method: "POST", path: "/orgs" },
  input: z.object({ name: z.string().trim().min(1).max(120), slug: slugSchema }),
  output: "Organization",
  policy: SignedInUser,
  requires: {
    slugIsFree: db.none("organization", { slug: e.input("slug") }),
  },
  ensures: {
    slugAsRequested: e.eq("result.slug", e.input("slug")),
    creatorIsOwner: db.unique("membership", { organizationId: e.result("id"), userId: e.actor("id"), role: "owner" }),
    freeSubscriptionOpened: db.unique("subscription", { organizationId: e.result("id"), plan: "free", status: "active" }),
  },
  effects: ["db:write"],
  handler: createOrganization,
  owner: "team-platform",
});

// --- members ---------------------------------------------------------------

export const InviteMember = action("Org.inviteMember", {
  intent: "An owner or admin invites a person by email. Re-inviting a pending email resends; inviting an existing member is an error.",
  route: { method: "POST", path: "/orgs/:orgId/invitations" },
  input: z.object({ orgId: idSchema, email: emailSchema, role: grantableRoleSchema }),
  output: Invitation,
  policy: OrgOwnerOrAdminUser,
  requires: {
    orgIsActive: db.exists("organization", { id: e.input("orgId"), deletedAt: null }),
    notAlreadyMember: db.none("membership", { organizationId: e.input("orgId"), user: { email: e.input("email") } }),
  },
  ensures: {
    pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
    roleAsRequested: e.eq("result.role", e.input("role")),
    scopedToOrg: e.eq("result.organizationId", e.input("orgId")),
    singlePendingInvitation: db.unique("invitation", { organizationId: e.input("orgId"), email: e.input("email"), status: "pending" }),
    eventEmitted: e.emitted(MemberInvited, 1),
  },
  effects: ["db:read", "db:write", "event:emit"],
  handler: inviteMember,
  owner: "team-platform",
});

export const AcceptInvite = action("Org.acceptInvite", {
  intent: "The signed-in user whose email matches a pending invitation joins the organization with the invited role.",
  route: { method: "POST", path: "/invitations/:token/accept" },
  input: z.object({ token: z.string().min(8).max(128) }),
  output: z.object({
    invitation: z.object({ id: z.string(), status: z.string(), acceptedById: z.string().nullable() }),
    membership: z.object({ id: z.string(), organizationId: z.string(), userId: z.string(), role: z.string() }),
    organization: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  }),
  policy: SignedInUser,
  subject: { entity: Invitation, where: { token: e.input("token") } },
  requires: {
    invitationIsPending: e.eq("self.status", "pending"),
    emailMatchesActor: e.eq("self.email", e.actor("email")),
    notAlreadyMember: db.none("membership", { organizationId: e.self("organizationId"), userId: e.actor("id") }),
  },
  ensures: {
    invitationAccepted: e.and(e.eq("self.status", "accepted"), e.eq("self.acceptedById", e.actor("id"))),
    membershipCreated: db.unique("membership", { organizationId: e.old("organizationId"), userId: e.actor("id"), role: e.old("role") }),
    resultRoleMatches: e.eq("result.membership.role", e.old("role")),
    eventEmitted: e.emitted(InvitationAccepted, 1),
  },
  effects: ["db:read", "db:write", "event:emit"],
  handler: acceptInvitation,
  owner: "team-platform",
});

export const RevokeInvitation = action("Org.revokeInvitation", {
  intent: "An owner or admin withdraws a pending invitation; the link stops working.",
  route: { method: "DELETE", path: "/orgs/:orgId/invitations/:invitationId" },
  input: z.object({ orgId: idSchema, invitationId: idSchema }),
  output: Invitation,
  policy: OrgOwnerOrAdmin,
  subject: { entity: Invitation, where: { id: e.input("invitationId"), organizationId: e.input("orgId") } },
  requires: {
    invitationIsPending: e.eq("self.status", "pending"),
  },
  ensures: {
    revoked: e.and(e.eq("self.status", "revoked"), e.not(e.isNull("self.revokedAt"))),
    resultRevoked: e.eq("result.status", "revoked"),
  },
  effects: ["db:read", "db:write"],
  handler: revokeInvitation,
  owner: "team-platform",
});

export const RemoveMember = action("Org.removeMember", {
  intent: "Owners and admins remove members (admins cannot remove owners); anyone may leave. The last owner can never be removed; the person's open tasks are unassigned.",
  route: { method: "DELETE", path: "/orgs/:orgId/members/:userId" },
  input: z.object({ orgId: idSchema, userId: idSchema }),
  output: z.object({ id: z.string(), organizationId: z.string(), userId: z.string(), role: roleSchema, removed: z.literal(true) }),
  policy: OrgAdminOrSelf,
  requires: {
    targetIsMember: db.exists("membership", { organizationId: e.input("orgId"), userId: e.input("userId") }),
    onlyOwnersRemoveOwners: e.or(
      db.none("membership", { organizationId: e.input("orgId"), userId: e.input("userId"), role: "owner" }),
      e.and(e.eq("actor.type", "user"), db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: "owner" })),
      e.eq("input.userId", e.actor("id")),
    ),
    notTheLastOwner: e.or(
      db.none("membership", { organizationId: e.input("orgId"), userId: e.input("userId"), role: "owner" }),
      e.gte(db.countWhere("membership", { organizationId: e.input("orgId"), role: "owner" }), 2),
    ),
  },
  ensures: {
    membershipGone: db.none("membership", { organizationId: e.input("orgId"), userId: e.input("userId") }),
    anOwnerRemains: db.exists("membership", { organizationId: e.input("orgId"), role: "owner" }),
    tasksUnassigned: db.none("task", { organizationId: e.input("orgId"), assigneeId: e.input("userId") }),
    resultEchoesTarget: e.and(e.eq("result.userId", e.input("userId")), e.eq("result.removed", true)),
    eventEmitted: e.emitted(MemberRemoved, 1),
  },
  effects: ["db:read", "db:write", "event:emit"],
  handler: removeMember,
  owner: "team-platform",
});

export const UpdateMemberRole = action("Org.updateMemberRole", {
  intent: "Change a member's role. Only owners grant or revoke the owner role; nobody demotes the last owner.",
  route: { method: "PATCH", path: "/orgs/:orgId/members/:userId" },
  input: z.object({ orgId: idSchema, userId: idSchema, role: roleSchema }),
  output: Membership,
  policy: OrgOwnerOrAdmin,
  subject: { entity: Membership, where: { organizationId: e.input("orgId"), userId: e.input("userId") } },
  requires: {
    targetIsMember: db.exists("membership", { organizationId: e.input("orgId"), userId: e.input("userId") }),
    onlyOwnersTouchOwnerRole: e.or(
      e.and(e.ne("input.role", "owner"), e.ne("self.role", "owner")),
      e.and(e.eq("actor.type", "user"), db.exists("membership", { organizationId: e.input("orgId"), userId: e.actor("id"), role: "owner" })),
    ),
    notDemotingLastOwner: e.or(
      e.ne("self.role", "owner"),
      e.eq("input.role", "owner"),
      e.gte(db.countWhere("membership", { organizationId: e.input("orgId"), role: "owner" }), 2),
    ),
  },
  ensures: {
    roleApplied: e.and(e.eq("self.role", e.input("role")), e.eq("result.role", e.input("role"))),
    anOwnerRemains: db.exists("membership", { organizationId: e.input("orgId"), role: "owner" }),
    eventEmittedWhenChanged: e.emitted(MemberRoleChanged, { max: 1 }),
  },
  effects: ["db:read", "db:write", "event:emit"],
  handler: updateMemberRole,
  owner: "team-platform",
});

// --- projects and tasks ----------------------------------------------------

/** The wire shape of a created project (`serializeProject` with the task count loaded), not the Project row. */
const createdProject = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  createdById: z.string(),
  archivedAt: z.string().nullable(),
  taskCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateProject = action("Org.createProject", {
  intent: "An owner or admin creates a project with a short key unique inside the organization (derived from the name when omitted).",
  route: { method: "POST", path: "/orgs/:orgId/projects" },
  input: z.object({ orgId: idSchema, name: z.string().trim().min(1).max(120), key: projectKeySchema.optional(), description: z.string().max(2000).optional() }),
  output: createdProject,
  policy: OrgOwnerOrAdmin,
  requires: {
    orgIsActive: db.exists("organization", { id: e.input("orgId"), deletedAt: null }),
  },
  ensures: {
    activeAndScoped: e.and(e.eq("result.status", "active"), e.eq("result.organizationId", e.input("orgId"))),
    nameAsRequested: e.eq("result.name", e.input("name")),
    keyUniqueInOrg: db.unique("project", { organizationId: e.input("orgId"), key: e.result("key") }),
    startsEmpty: e.eq("result.taskCount", 0),
    eventEmitted: e.emitted(ProjectCreated, 1),
  },
  effects: ["db:read", "db:write", "event:emit"],
  handler: createProject,
  owner: "team-product",
});

export const ArchiveProject = action("Org.archiveProject", {
  intent: "Archive a project; it becomes read-only and no tasks can be added.",
  route: { method: "POST", path: "/orgs/:orgId/projects/:projectId/archive" },
  input: z.object({ orgId: idSchema, projectId: idSchema }),
  output: Project,
  policy: OrgOwnerOrAdmin,
  subject: { entity: Project, where: { id: e.input("projectId"), organizationId: e.input("orgId") } },
  requires: {
    projectIsActive: e.eq("self.status", "active"),
  },
  ensures: {
    archived: e.and(e.eq("self.status", "archived"), e.not(e.isNull("self.archivedAt"))),
    resultArchived: e.eq("result.status", "archived"),
  },
  effects: ["db:read", "db:write"],
  handler: archiveProject,
  owner: "team-product",
});

export const CreateTask = action("Org.createTask", {
  intent: "Any member adds a task to an active project of their organization; the task gets the next number in the project and starts as todo.",
  route: { method: "POST", path: "/orgs/:orgId/projects/:projectId/tasks" },
  input: z.object({
    orgId: idSchema,
    projectId: idSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).optional(),
    priority: taskPrioritySchema.default("medium"),
    assigneeId: idSchema.nullable().optional(),
    dueAt: z.iso.datetime().optional(),
  }),
  output: Task,
  policy: OrgMember,
  subject: { entity: Project, where: { id: e.input("projectId"), organizationId: e.input("orgId") } },
  requires: {
    projectIsActive: e.eq("self.status", "active"),
    assigneeIsMember: e.or(e.isNull("input.assigneeId"), db.exists("membership", { organizationId: e.input("orgId"), userId: e.input("assigneeId") })),
  },
  ensures: {
    startsAsTodo: e.and(e.eq("result.status", "todo"), e.isNull("result.completedAt")),
    inProjectAndOrg: e.and(e.eq("result.projectId", e.input("projectId")), e.eq("result.organizationId", e.input("orgId"))),
    titleAsRequested: e.eq("result.title", e.input("title")),
    priorityAsRequested: e.eq("result.priority", e.input("priority")),
    counterAdvanced: e.gt("self.taskCounter", e.old("taskCounter")),
    numberIsCounter: e.eq("result.number", e.self("taskCounter")),
    eventEmitted: e.emitted(TaskCreated, 1),
  },
  effects: ["db:read", "db:write", "event:emit"],
  handler: createTask,
  owner: "team-product",
});

// --- API keys --------------------------------------------------------------

export const CreateApiKey = action("Org.createApiKey", {
  intent: "An owner or admin creates an organization API key; the secret is returned exactly once.",
  route: { method: "POST", path: "/orgs/:orgId/api-keys" },
  input: z.object({ orgId: idSchema, name: z.string().trim().min(1).max(80), role: grantableRoleSchema.default("member") }),
  output: z.object({ id: z.string(), organizationId: z.string(), name: z.string(), role: z.string(), prefix: z.string(), version: z.number(), secret: z.string() }),
  policy: OrgOwnerOrAdminUser,
  requires: {
    orgIsActive: db.exists("organization", { id: e.input("orgId"), deletedAt: null }),
  },
  ensures: {
    scopedToOrg: e.eq("result.organizationId", e.input("orgId")),
    secretIsLong: e.gte(e.len("result.secret"), 32),
    firstVersion: e.eq("result.version", 1),
    keyPersisted: db.unique("apiKey", { id: e.result("id"), organizationId: e.input("orgId"), revokedAt: null }),
  },
  effects: ["db:write"],
  handler: createApiKey,
  owner: "team-platform",
});

export const RotateApiKey = action("Org.rotateApiKey", {
  intent: "Rotate an API key's secret. The key keeps its identity, `version` increases and the previous secret stops working immediately.",
  route: { method: "POST", path: "/orgs/:orgId/api-keys/:keyId/rotate" },
  input: z.object({ orgId: idSchema, keyId: idSchema }),
  output: z.object({ id: z.string(), organizationId: z.string(), version: z.number(), prefix: z.string(), secret: z.string() }),
  policy: OrgOwnerOrAdminUser,
  subject: { entity: ApiKey, where: { id: e.input("keyId"), organizationId: e.input("orgId") } },
  requires: {
    keyNotRevoked: e.isNull("self.revokedAt"),
  },
  ensures: {
    versionBumped: e.gt("self.version", e.old("version")),
    rotatedAtSet: e.not(e.isNull("self.rotatedAt")),
    sameIdentity: e.and(e.eq("result.id", e.input("keyId")), e.eq("result.version", e.self("version"))),
    secretIsLong: e.gte(e.len("result.secret"), 32),
    eventEmitted: e.emitted(ApiKeyRotated, 1),
  },
  effects: ["db:read", "db:write", "event:emit"],
  handler: rotateApiKey,
  owner: "team-platform",
});

// --- billing ---------------------------------------------------------------

export const HandleBillingWebhook = action("Billing.handleStripeWebhook", {
  intent: "Receive a Stripe webhook: verify the signature over the raw body, record the event id once, apply the subscription change. Replays are acknowledged without a second effect.",
  route: { method: "POST", path: "/webhooks/stripe" },
  input: stripeEventSchema,
  output: z.object({ received: z.literal(true), eventId: z.string(), duplicate: z.boolean(), status: z.enum(["processed", "ignored"]) }),
  public: true,
  ensures: {
    acknowledged: e.and(e.eq("result.received", true), e.eq("result.eventId", e.input("id"))),
    recordedOnce: db.unique("webhookEvent", { provider: "stripe", eventId: e.input("id") }),
  },
  effects: ["db:read", "db:write", "event:emit"],
  idempotency: { key: { input: "id" }, ttlSeconds: 30 * 24 * 60 * 60 },
  handler: handleStripeWebhook,
  owner: "team-billing",
});

export const actions = [
  CreateOrganization,
  InviteMember,
  AcceptInvite,
  RevokeInvitation,
  RemoveMember,
  UpdateMemberRole,
  CreateProject,
  ArchiveProject,
  CreateTask,
  CreateApiKey,
  RotateApiKey,
  HandleBillingWebhook,
] as const;
