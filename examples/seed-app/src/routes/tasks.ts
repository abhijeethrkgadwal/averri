import { Hono } from "hono";
import { z } from "zod";
import { requireOrgRole } from "../auth.js";
import type { AppEnv } from "../context.js";
import { idSchema } from "../lib/constants.js";
import { paginationQuerySchema } from "../lib/pagination.js";
import { parseBody, parseParams, parseQuery } from "../lib/validation.js";
import { createTask, createTaskSchema, deleteTask, getTask, listTasks, listTasksQuerySchema, updateTask, updateTaskSchema } from "../services/tasks.js";

const projectParams = z.object({ orgId: idSchema, projectId: idSchema });
const taskParams = z.object({ orgId: idSchema, taskId: idSchema });
const ALL_ROLES = ["owner", "admin", "member"] as const;

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.post("/orgs/:orgId/projects/:projectId/tasks", async (c) => {
  const { orgId, projectId } = parseParams(c, projectParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ALL_ROLES);
  const input = await parseBody(c, createTaskSchema);
  return c.json(await createTask(c.get("deps"), access, projectId, input), 201);
});

taskRoutes.get("/orgs/:orgId/projects/:projectId/tasks", async (c) => {
  const { orgId, projectId } = parseParams(c, projectParams);
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ALL_ROLES);
  const query = parseQuery(c, paginationQuerySchema.extend(listTasksQuerySchema.shape));
  return c.json(await listTasks(c.get("deps"), orgId, projectId, query, query));
});

taskRoutes.get("/orgs/:orgId/tasks/:taskId", async (c) => {
  const { orgId, taskId } = parseParams(c, taskParams);
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ALL_ROLES);
  return c.json(await getTask(c.get("deps"), orgId, taskId));
});

taskRoutes.patch("/orgs/:orgId/tasks/:taskId", async (c) => {
  const { orgId, taskId } = parseParams(c, taskParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ALL_ROLES);
  const input = await parseBody(c, updateTaskSchema);
  return c.json(await updateTask(c.get("deps"), access, taskId, input));
});

taskRoutes.delete("/orgs/:orgId/tasks/:taskId", async (c) => {
  const { orgId, taskId } = parseParams(c, taskParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  return c.json(await deleteTask(c.get("deps"), access, taskId));
});
