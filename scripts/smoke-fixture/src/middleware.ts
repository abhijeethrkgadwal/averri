import type { MiddlewareHandler } from "hono";

/** `Authorization: Bearer <userId>`; anything else is anonymous. */
export const auth: MiddlewareHandler = async (c, next) => {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!token) return c.json({ error: "Unauthenticated" }, 401);
  c.set("actor", { id: token });
  await next();
};
