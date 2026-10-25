import { Hono } from "hono";
import type { AppEnv } from "../context.js";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/health", async (c) => {
  const deps = c.get("deps");
  await deps.db.$queryRaw`SELECT 1`;
  return c.json({ ok: true, time: deps.now().toISOString() });
});
