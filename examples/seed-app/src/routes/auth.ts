import { Hono } from "hono";
import { bearerToken, requireUser } from "../auth.js";
import type { AppEnv } from "../context.js";
import { parseBody } from "../lib/validation.js";
import { getProfile, login, loginSchema, logout, register, registerSchema, updateProfile, updateProfileSchema } from "../services/users.js";

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/auth/register", async (c) => {
  const input = await parseBody(c, registerSchema);
  const result = await register(c.get("deps"), input);
  return c.json(result, 201);
});

authRoutes.post("/auth/login", async (c) => {
  const input = await parseBody(c, loginSchema);
  const result = await login(c.get("deps"), input);
  return c.json(result);
});

authRoutes.post("/auth/logout", async (c) => {
  requireUser(c);
  const token = bearerToken(c.req.header("authorization"));
  if (token !== null) await logout(c.get("deps"), token);
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  const actor = requireUser(c);
  return c.json(await getProfile(c.get("deps"), actor));
});

authRoutes.patch("/me", async (c) => {
  const actor = requireUser(c);
  const input = await parseBody(c, updateProfileSchema);
  return c.json(await updateProfile(c.get("deps"), actor, input));
});
