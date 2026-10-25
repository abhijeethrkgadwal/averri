// @ts-nocheck — fixture: a second declaration with an existing id (A1001).
import { action } from "@averri/core";
import { z } from "zod";
import { OwnerOrAdmin } from "./policies.js";

export const InviteMemberAgain = action("Team.inviteMember", {
  intent: "Duplicate id.",
  route: { method: "POST", path: "/teams/:teamId/invitations" },
  input: z.object({ teamId: z.string() }),
  policy: OwnerOrAdmin,
  effects: ["db:write"],
});
