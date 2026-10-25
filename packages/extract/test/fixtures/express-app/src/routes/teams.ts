import express, { Router } from "express";
import { requireRole } from "../middleware/auth.js";
import { inviteMember, listTeams, removeMember } from "../handlers.js";

export const teamsRouter = Router();

teamsRouter.use(requireRole("member"));
teamsRouter.get("/", listTeams);
teamsRouter.post("/:teamId/invitations", requireRole("admin"), inviteMember);

const members = express.Router();
members.delete("/:userId", removeMember);
teamsRouter.use("/:teamId/members", members);
