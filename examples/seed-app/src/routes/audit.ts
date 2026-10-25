import { Hono } from "hono";
import { z } from "zod";
import { requireOrgRole } from "../auth.js";
import type { AppEnv } from "../context.js";
import { idSchema } from "../lib/constants.js";
import { paginationQuerySchema } from "../lib/pagination.js";
import { parseParams, parseQuery } from "../lib/validation.js";
import { listAudit } from "../services/audit.js";

const orgParams = z.object({ orgId: idSchema });
const listQuery = paginationQuerySchema.extend({ action: z.string().min(1).max(80).optional(), targetType: z.string().min(1).max(40).optional() });

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.get("/orgs/:orgId/audit-log", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  const query = parseQuery(c, listQuery);
  return c.json(await listAudit(c.get("deps").db, orgId, query, { action: query.action, targetType: query.targetType }));
});
