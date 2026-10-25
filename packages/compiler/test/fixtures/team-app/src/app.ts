// @ts-nocheck — fixture
import { Hono } from "hono";
import { auth } from "./middleware.js";
import { teamRoutes } from "./routes/teams.js";
import { webhookRoutes } from "./routes/webhooks.js";

export const app = new Hono();

app.use("/teams/*", auth);
app.route("/", teamRoutes);
app.route("/", webhookRoutes);
app.get("/health", (c) => c.json({ ok: true }));

export default app;
