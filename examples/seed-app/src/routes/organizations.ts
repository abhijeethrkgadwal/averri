import { Hono } from "hono";
import { z } from "zod";
import { requireOrgRole, requireUser } from "../auth.js";
import type { AppEnv } from "../context.js";
import { idSchema } from "../lib/constants.js";
import { paginationQuerySchema } from "../lib/pagination.js";
import { parseBody, parseParams, parseQuery } from "../lib/validation.js";
import {
  createOrganization,
  createOrganizationSchema,
  deleteOrganization,
  getOrganization,
  listMyOrganizations,
  updateOrganization,
  updateOrganizationSchema,
} from "../services/organizations.js";

export const orgParams = z.object({ orgId: idSchema });

export const organizationRoutes = new Hono<AppEnv>();

organizationRoutes.post("/orgs", async (c) => {
  const actor = requireUser(c);
  const input = await parseBody(c, createOrganizationSchema);
  return c.json(await createOrganization(c.get("deps"), actor, input), 201);
});

organizationRoutes.get("/orgs", async (c) => {
  const actor = requireUser(c);
  const query = parseQuery(c, paginationQuerySchema);
  return c.json(await listMyOrganizations(c.get("deps"), actor, query));
});

organizationRoutes.get("/orgs/:orgId", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin", "member"]);
  return c.json(await getOrganization(c.get("deps"), orgId, access.role));
});

organizationRoutes.patch("/orgs/:orgId", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  const actor = requireUser(c);
  await requireOrgRole(c.get("deps"), actor, orgId, ["owner", "admin"]);
  const input = await parseBody(c, updateOrganizationSchema);
  return c.json(await updateOrganization(c.get("deps"), actor, orgId, input));
});

organizationRoutes.delete("/orgs/:orgId", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  const actor = requireUser(c);
  await requireOrgRole(c.get("deps"), actor, orgId, ["owner"]);
  return c.json(await deleteOrganization(c.get("deps"), actor, orgId));
});
