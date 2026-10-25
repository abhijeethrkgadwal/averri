import type { Hono } from "hono";

export function registerExtra(app: Hono) {
  app.get("/extra", (c) => c.text("extra"));
}
