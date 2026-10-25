/**
 * Closed value sets. The Prisma schema stores these as `String` (SQLite has no enums); the Zod
 * schemas here are the single source of truth for what the application accepts.
 */
import { z } from "zod";

export const ROLES = ["owner", "admin", "member"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.output<typeof roleSchema>;

/** Roles an invitation or API key may carry (owners are never created through invitations). */
export const GRANTABLE_ROLES = ["admin", "member"] as const;
export const grantableRoleSchema = z.enum(GRANTABLE_ROLES);
export type GrantableRole = z.output<typeof grantableRoleSchema>;

export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export const invitationStatusSchema = z.enum(INVITATION_STATUSES);
export type InvitationStatus = z.output<typeof invitationStatusSchema>;

export const PROJECT_STATUSES = ["active", "archived"] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.output<typeof projectStatusSchema>;

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.output<typeof taskStatusSchema>;

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.output<typeof taskPrioritySchema>;

export const PLANS = ["free", "pro", "enterprise"] as const;
export const planSchema = z.enum(PLANS);
export type Plan = z.output<typeof planSchema>;

export const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "canceled", "incomplete"] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.output<typeof subscriptionStatusSchema>;

export const WEBHOOK_EVENT_STATUSES = ["processed", "ignored", "failed"] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const AUDIT_ACTOR_TYPES = ["user", "apiKey", "webhook", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Rank used for "may act on" comparisons: owners outrank admins outrank members. */
export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const STRIPE_SIGNATURE_TOLERANCE_S = 300;

export const emailSchema = z.email().max(254).transform((value) => value.trim().toLowerCase());
export const idSchema = z.string().min(1).max(64);
export const slugSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "slug must be lower-case letters, digits and single hyphens");
export const projectKeySchema = z
  .string()
  .min(2)
  .max(8)
  .regex(/^[A-Z][A-Z0-9]*$/, "key must be 2-8 upper-case letters or digits, starting with a letter");
