import { Hono } from "hono";
import { z } from "zod";
import { requireOrgRole } from "../auth.js";
import type { AppEnv } from "../context.js";
import { idSchema, roleSchema } from "../lib/constants.js";
import { paginationQuerySchema } from "../lib/pagination.js";
import { parseBody, parseParams, parseQuery } from "../lib/validation.js";
import { listMembers, removeMember, updateMemberRole, updateMemberRoleSchema } from "../services/members.js";

const memberParams = z.object({ orgId: idSchema, userId: idSchema });
const listQuery = paginationQuerySchema.extend({ role: roleSchema.optional() });

export const memberRoutes = new Hono<AppEnv>();

memberRoutes.get("/orgs/:orgId/members", async (c) => {
  const { orgId } = parseParams(c, z.object({ orgId: idSchema }));
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin", "member"]);
  const query = parseQuery(c, listQuery);
  return c.json(await listMembers(c.get("deps"), orgId, query, { role: query.role }));
});

memberRoutes.patch("/orgs/:orgId/members/:userId", async (c) => {
  const { orgId, userId } = parseParams(c, memberParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  const input = await parseBody(c, updateMemberRoleSchema);
  return c.json(await updateMemberRole(c.get("deps"), access, userId, input));
});

memberRoutes.delete("/orgs/:orgId/members/:userId", async (c) => {
  const { orgId, userId } = parseParams(c, memberParams);
  // Members may leave (remove themselves); the service enforces who may remove others.
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin", "member"]);
  return c.json(await removeMember(c.get("deps"), access, userId));
});
