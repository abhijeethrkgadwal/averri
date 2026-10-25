/**
 * Domain events. Names match the `"averri/<Name>"` strings sent through `src/events.ts`.
 */
import { event } from "@averri/core";

export const MemberInvited = event("MemberInvited", {
  intent: "An invitation was created or resent; InviteFlow emails the link.",
  payload: { invitationId: "string", organizationId: "string", email: "string", token: "string" },
});

export const InvitationAccepted = event("InvitationAccepted", {
  intent: "An invited person joined the organization.",
  payload: { invitationId: "string", organizationId: "string", userId: "string", role: "string" },
  external: true,
});

export const MemberRemoved = event("MemberRemoved", {
  intent: "A membership ended (removed by an admin or the member left).",
  payload: { organizationId: "string", userId: "string", role: "string", removedBy: "string", self: "boolean" },
  external: true,
});

export const MemberRoleChanged = event("MemberRoleChanged", {
  payload: { organizationId: "string", userId: "string", from: "string", to: "string", changedBy: "string" },
  external: true,
});

export const ProjectCreated = event("ProjectCreated", {
  payload: { projectId: "string", organizationId: "string", key: "string", createdBy: "string" },
  external: true,
});

export const TaskCreated = event("TaskCreated", {
  payload: { taskId: "string", organizationId: "string", projectId: "string", assigneeId: "json", createdBy: "string" },
  external: true,
});

export const ApiKeyRotated = event("ApiKeyRotated", {
  payload: { apiKeyId: "string", organizationId: "string", version: "number", rotatedBy: "string" },
  external: true,
});

export const SubscriptionChanged = event("SubscriptionChanged", {
  intent: "A Stripe webhook changed the organization's subscription state.",
  payload: { organizationId: "string", eventId: "string", type: "string" },
  external: true,
});

export const events = [MemberInvited, InvitationAccepted, MemberRemoved, MemberRoleChanged, ProjectCreated, TaskCreated, ApiKeyRotated, SubscriptionChanged] as const;
