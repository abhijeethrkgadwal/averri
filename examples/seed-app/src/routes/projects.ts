import { Hono } from "hono";
import { z } from "zod";
import { requireOrgRole } from "../auth.js";
import type { AppEnv } from "../context.js";
import { idSchema } from "../lib/constants.js";
import { paginationQuerySchema } from "../lib/pagination.js";
import { parseBody, parseParams, parseQuery } from "../lib/validation.js";
import {
  archiveProject,
  createProject,
  createProjectSchema,
  getProject,
  listProjects,
  listProjectsQuerySchema,
  updateProject,
  updateProjectSchema,
} from "../services/projects.js";

const orgParams = z.object({ orgId: idSchema });
const projectParams = z.object({ orgId: idSchema, projectId: idSchema });

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.post("/orgs/:orgId/projects", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  const input = await parseBody(c, createProjectSchema);
  return c.json(await createProject(c.get("deps"), access, input), 201);
});

projectRoutes.get("/orgs/:orgId/projects", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin", "member"]);
  const query = parseQuery(c, paginationQuerySchema.extend(listProjectsQuerySchema.shape));
  return c.json(await listProjects(c.get("deps"), orgId, query, { status: query.status }));
});

projectRoutes.get("/orgs/:orgId/projects/:projectId", async (c) => {
  const { orgId, projectId } = parseParams(c, projectParams);
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin", "member"]);
  return c.json(await getProject(c.get("deps"), orgId, projectId));
});

projectRoutes.patch("/orgs/:orgId/projects/:projectId", async (c) => {
  const { orgId, projectId } = parseParams(c, projectParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  const input = await parseBody(c, updateProjectSchema);
  return c.json(await updateProject(c.get("deps"), access, projectId, input));
});

projectRoutes.post("/orgs/:orgId/projects/:projectId/archive", async (c) => {
  const { orgId, projectId } = parseParams(c, projectParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  return c.json(await archiveProject(c.get("deps"), access, projectId));
});
