// @ts-nocheck — fixture
import { db, e, policy } from "@averri/core";

export const OwnerOrAdmin = policy("Team.OwnerOrAdmin", {
  intent: "Owners and admins manage membership; members cannot.",
  allow: db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }),
});

export const Anyone = policy("Team.Anyone", {
  allow: async ({ actor }) => actor.id !== "",
});
