import { Hono } from "hono";
import { z } from "zod";
import { requireOrgRole, requireUser } from "../auth.js";
import type { AppEnv } from "../context.js";
import { idSchema } from "../lib/constants.js";
import { paginationQuerySchema } from "../lib/pagination.js";
import { parseBody, parseParams, parseQuery } from "../lib/validation.js";
import {
  acceptInvitation,
  inviteMember,
  inviteMemberSchema,
  listInvitations,
  listInvitationsQuerySchema,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
} from "../services/invitations.js";

const orgParams = z.object({ orgId: idSchema });
const invitationParams = z.object({ orgId: idSchema, invitationId: idSchema });
const tokenParams = z.object({ token: z.string().min(8).max(128) });

export const invitationRoutes = new Hono<AppEnv>();

invitationRoutes.post("/orgs/:orgId/invitations", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  const input = await parseBody(c, inviteMemberSchema);
  return c.json(await inviteMember(c.get("deps"), access, input), 201);
});

invitationRoutes.get("/orgs/:orgId/invitations", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  const query = parseQuery(c, paginationQuerySchema.extend(listInvitationsQuerySchema.shape));
  return c.json(await listInvitations(c.get("deps"), orgId, query, { status: query.status }));
});

invitationRoutes.post("/orgs/:orgId/invitations/:invitationId/resend", async (c) => {
  const { orgId, invitationId } = parseParams(c, invitationParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  return c.json(await resendInvitation(c.get("deps"), access, invitationId));
});

invitationRoutes.delete("/orgs/:orgId/invitations/:invitationId", async (c) => {
  const { orgId, invitationId } = parseParams(c, invitationParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  return c.json(await revokeInvitation(c.get("deps"), access, invitationId));
});

/** Public: the landing page needs to show who invited you before you sign in. */
invitationRoutes.get("/invitations/:token", async (c) => {
  const { token } = parseParams(c, tokenParams);
  return c.json(await previewInvitation(c.get("deps"), token));
});

invitationRoutes.post("/invitations/:token/accept", async (c) => {
  const { token } = parseParams(c, tokenParams);
  const actor = requireUser(c);
  return c.json(await acceptInvitation(c.get("deps"), actor, token));
});
