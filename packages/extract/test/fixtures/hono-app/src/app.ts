import { Hono } from "hono";
import { auth } from "./middleware/auth.js";
import { teams } from "./routes/teams.js";
import billing from "./routes/billing.js";
import { versioned } from "./routes/versioned.js";
import { registerExtra } from "./routes/byParam.js";

const version = process.env.API_VERSION ?? "v1";

export const app = new Hono().basePath("/api");

app.use("/teams/*", auth());
app.get("/health", (c) => c.json({ ok: true }));
app.route("/teams", teams);
app.route("/billing", billing);
app.route(`/${version}`, versioned);
registerExtra(app);

for (const p of ["/a", "/b"]) {
  app.get(p, (c) => c.text(p));
}

export default app;
