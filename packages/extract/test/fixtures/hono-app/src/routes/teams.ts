import { Hono } from "hono";
import { requireUser, requireRole, publicRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { InviteMember, inviteMember } from "../members/inviteMember.js";
import { listTeams, removeMember, exportTeam, updateTeam } from "../handlers.js";

export const teams = new Hono();

teams.use("*", requireUser());

teams.get("/", listTeams);
teams.post("/:teamId/invitations", requireRole("admin"), validate(InviteMember.input), inviteMember);
teams.patch("/:teamId{[0-9]+}/", updateTeam);
teams.on(["PUT", "DELETE"], "/:teamId/members/:userId", removeMember);
teams.all("/:teamId/ping", (c) => c.text("pong"));
teams.get("/:teamId/export", publicRoute(), exportTeam);
teams.options("/:teamId", (c) => c.text(""));
