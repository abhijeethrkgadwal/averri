// @ts-nocheck — fixture
import { Hono } from "hono";
import { RemoveTeam } from "../averri/actions.js";
import { inviteMemberHandler, listInvitationsHandler } from "../handlers.js";

function toHono(decl, options) {
  return async (c) => c.json({ decl: decl.id, options: !!options });
}

export const teamRoutes = new Hono();

teamRoutes.post("/teams/:teamId/invitations", inviteMemberHandler);
teamRoutes.get("/teams/:teamId/invitations", listInvitationsHandler);
teamRoutes.get("/teams/:teamId/members", (c) => c.json([]));
teamRoutes.get("/teams/:teamId/settings", (c) => c.json({}));
teamRoutes.get("/teams/:teamId/stats", (c) => c.json({}));
teamRoutes.patch("/teams/:teamId", (c) => c.json({}));
teamRoutes.delete("/teams/:teamId", toHono(RemoveTeam, { actor: () => null }));
