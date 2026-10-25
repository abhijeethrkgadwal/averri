/**
 * Observe-mode query declarations (reads): policy + input only, no contracts.
 */
import { query } from "@averri/core";
import { z } from "zod";
import { idSchema, roleSchema } from "../lib/constants.js";
import { isValidCursor } from "../lib/pagination.js";
import { OrgMember, OrgOwnerOrAdmin } from "./policies.js";
import { listAudit } from "../services/audit.js";
import { getBilling } from "../services/billing.js";
import { listMembers } from "../services/members.js";
import { listProjects } from "../services/projects.js";

/** The app rejects cursors it did not issue (400 invalid_cursor), so the declared schema does too. */
const pagination = { limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().min(1).refine(isValidCursor, "cursor is not valid").optional() };

export const ListMembers = query("Org.listMembers", {
  intent: "Members of the organization, newest first, cursor-paginated.",
  route: { method: "GET", path: "/orgs/:orgId/members" },
  input: z.object({ orgId: idSchema, role: roleSchema.optional(), ...pagination }),
  policy: OrgMember,
  handler: listMembers,
  owner: "team-platform",
});

export const ListProjects = query("Org.listProjects", {
  intent: "Projects of the organization with task counts, cursor-paginated.",
  route: { method: "GET", path: "/orgs/:orgId/projects" },
  input: z.object({ orgId: idSchema, status: z.enum(["active", "archived"]).optional(), ...pagination }),
  policy: OrgMember,
  handler: listProjects,
  owner: "team-product",
});

export const GetBilling = query("Billing.getSubscription", {
  intent: "The organization's subscription state as mirrored from Stripe.",
  route: { method: "GET", path: "/orgs/:orgId/billing" },
  input: z.object({ orgId: idSchema }),
  output: "Subscription",
  policy: OrgOwnerOrAdmin,
  handler: getBilling,
  owner: "team-billing",
});

export const ListAuditLog = query("Org.listAuditLog", {
  intent: "The organization's audit trail, newest first.",
  route: { method: "GET", path: "/orgs/:orgId/audit-log" },
  input: z.object({ orgId: idSchema, action: z.string().optional(), targetType: z.string().optional(), ...pagination }),
  policy: OrgOwnerOrAdmin,
  handler: listAudit,
  owner: "team-platform",
});

export const queries = [ListMembers, ListProjects, GetBilling, ListAuditLog] as const;
