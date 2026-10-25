import { Hono } from "hono";

export const orphan = new Hono();

orphan.get("/lost", (c) => c.text("nobody mounts me"));
