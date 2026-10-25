// @ts-nocheck — fixture: the seed app's declared routes, registered with stub handlers
import { Hono } from "hono";
import { auth } from "./auth.js";

export const app = new Hono();
app.use("*", auth);

const ok = (c) => c.json({ ok: true });

app.post("/orgs", ok);
app.post("/orgs/:orgId/invitations", ok);
app.post("/invitations/:token/accept", ok);
app.delete("/orgs/:orgId/invitations/:invitationId", ok);
app.delete("/orgs/:orgId/members/:userId", ok);
app.patch("/orgs/:orgId/members/:userId", ok);
app.post("/orgs/:orgId/projects", ok);
app.post("/orgs/:orgId/projects/:projectId/archive", ok);
app.post("/orgs/:orgId/projects/:projectId/tasks", ok);
app.post("/orgs/:orgId/api-keys", ok);
app.post("/orgs/:orgId/api-keys/:keyId/rotate", ok);
app.get("/orgs/:orgId/members", ok);
app.get("/orgs/:orgId/projects", ok);
app.get("/orgs/:orgId/billing", ok);
app.get("/orgs/:orgId/audit-log", ok);
app.get("/health", ok);

export default app;
