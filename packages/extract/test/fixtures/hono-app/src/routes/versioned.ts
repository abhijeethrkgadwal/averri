import { Hono } from "hono";

export const versioned = new Hono();

versioned.get("/info", (c) => c.json({ version: 1 }));
