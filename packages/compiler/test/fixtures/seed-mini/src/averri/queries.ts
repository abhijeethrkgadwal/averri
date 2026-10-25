// @ts-nocheck — copied from examples/seed-app for @averri/compiler tests
/**
 * Observe-mode query declarations (reads): policy + input only, no contracts.
 */
import { query } from "@averri/core";
import { z } from "zod";
import { idSchema, roleSchema } from "../lib/constants.js";
import { OrgMember, OrgOwnerOrAdmin } from "./policies.js";

const pagination = { limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().optional() };

export const ListMembers = query("Org.listMembers", {
  intent: "Members of the organization, newest first, cursor-paginated.",
  route: { method: "GET", path: "/orgs/:orgId/members" },
  input: z.object({ orgId: idSchema, role: roleSchema.optional(), ...pagination }),
  policy: OrgMember,
  owner: "team-platform",
});

export const ListProjects = query("Org.listProjects", {
  intent: "Projects of the organization with task counts, cursor-paginated.",
  route: { method: "GET", path: "/orgs/:orgId/projects" },
  input: z.object({ orgId: idSchema, status: z.enum(["active", "archived"]).optional(), ...pagination }),
  policy: OrgMember,
  owner: "team-product",
});

export const GetBilling = query("Billing.getSubscription", {
  intent: "The organization's subscription state as mirrored from Stripe.",
  route: { method: "GET", path: "/orgs/:orgId/billing" },
  input: z.object({ orgId: idSchema }),
  output: "Subscription",
  policy: OrgOwnerOrAdmin,
  owner: "team-billing",
});

export const ListAuditLog = query("Org.listAuditLog", {
  intent: "The organization's audit trail, newest first.",
  route: { method: "GET", path: "/orgs/:orgId/audit-log" },
  input: z.object({ orgId: idSchema, action: z.string().optional(), targetType: z.string().optional(), ...pagination }),
  policy: OrgOwnerOrAdmin,
  owner: "team-platform",
});

export const queries = [ListMembers, ListProjects, GetBilling, ListAuditLog] as const;
