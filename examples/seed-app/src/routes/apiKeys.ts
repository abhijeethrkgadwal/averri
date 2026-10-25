import { Hono } from "hono";
import { z } from "zod";
import { requireOrgRole } from "../auth.js";
import type { AppEnv } from "../context.js";
import { idSchema } from "../lib/constants.js";
import { paginationQuerySchema } from "../lib/pagination.js";
import { parseBody, parseParams, parseQuery } from "../lib/validation.js";
import { createApiKey, createApiKeySchema, listApiKeys, revokeApiKey, rotateApiKey } from "../services/apiKeys.js";

const orgParams = z.object({ orgId: idSchema });
const keyParams = z.object({ orgId: idSchema, keyId: idSchema });
const listQuery = paginationQuerySchema.extend({ includeRevoked: z.enum(["true", "false"]).default("false") });

export const apiKeyRoutes = new Hono<AppEnv>();

apiKeyRoutes.post("/orgs/:orgId/api-keys", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  const input = await parseBody(c, createApiKeySchema);
  return c.json(await createApiKey(c.get("deps"), access, input), 201);
});

apiKeyRoutes.get("/orgs/:orgId/api-keys", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  const query = parseQuery(c, listQuery);
  return c.json(await listApiKeys(c.get("deps"), orgId, query, { includeRevoked: query.includeRevoked === "true" }));
});

apiKeyRoutes.post("/orgs/:orgId/api-keys/:keyId/rotate", async (c) => {
  const { orgId, keyId } = parseParams(c, keyParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  return c.json(await rotateApiKey(c.get("deps"), access, keyId));
});

apiKeyRoutes.delete("/orgs/:orgId/api-keys/:keyId", async (c) => {
  const { orgId, keyId } = parseParams(c, keyParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  return c.json(await revokeApiKey(c.get("deps"), access, keyId));
});
