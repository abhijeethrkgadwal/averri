// @ts-nocheck — fixture: several declarations below are deliberately wrong (each triggers one rule).
import { action, db, e, query } from "@averri/core";
import { z } from "zod";
import { listInvitationsHandler } from "../handlers.js";
import { stripe } from "../stripe.js";
import { Invitation } from "./entities.js";
import { MemberInvited } from "./events.js";
import { OwnerOrAdmin } from "./policies.js";

const TTL = 7 * 24 * 60 * 60;

export const InviteMember = action("Team.inviteMember", {
  intent: "An owner or admin invites a person by email.",
  route: { method: "POST", path: "/teams/:teamId/invitations" },
  input: z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) }),
  output: Invitation,
  policy: OwnerOrAdmin,
  requires: {
    notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),
  },
  ensures: {
    pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
    eventEmitted: e.emitted(MemberInvited, 1),
  },
  effects: ["db:write", "event:emit"],
  idempotency: { key: { header: "idempotency-key" }, ttlSeconds: 24 * 60 * 60 },
  run: async ({ input, actor, tx, emit }) => {
    const inv = await tx.invitation.upsert({
      where: { teamId_email: { teamId: input.teamId, email: input.email } },
      create: { teamId: input.teamId, email: input.email, role: input.role, status: "pending" },
      update: { role: input.role },
    });
    emit(MemberInvited, { invitationId: inv.id, teamId: inv.teamId, email: inv.email });
    return inv;
  },
});

export const ListInvites = query("Team.listInvites", {
  intent: "List a team's invitations.",
  route: { method: "GET", path: "/teams/:teamId/invites" },
  input: z.object({ teamId: z.string() }),
  policy: OwnerOrAdmin,
  handler: listInvitationsHandler,
});

export const RenameTeam = action("Team.rename", {
  route: { method: "PATCH", path: "/teams/:teamId" },
  input: z.object({ teamId: z.string(), name: z.string().min(1) }),
  policy: OwnerOrAdmin,
  effects: ["db:read"],
  run: async ({ input, tx }) => tx.team.update({ where: { id: input.teamId }, data: { name: input.name } }),
});

export const RemoveTeam = action("Team.remove", {
  intent: "Owners delete a team.",
  route: { method: "DELETE", path: "/teams/:id" },
  input: z.object({ teamId: z.string() }),
  policy: OwnerOrAdmin,
  effects: ["db:write", "network"],
  run: async ({ input, tx, emit }) => {
    await stripe.charges.create({ team: input.teamId });
    emit(TeamArchived, { teamId: input.teamId, archived: true });
    return tx.team.delete({ where: { id: input.teamId } });
  },
});

export const AcceptInvite = action("Team.acceptInvite", {
  intent: "The invited person accepts.",
  route: { method: "POST", path: "/invitations/:invitationId/accept" },
  input: z.object({ invitationId: z.string(), seats: z.string() }),
  output: "Invitation",
  policy: OwnerOrAdmin,
  subject: { entity: Invitation, where: { id: e.input("invitationId") } },
  requires: {
    isPending: e.eq("self.Status", "pending"),
    sameTeam: e.eq("self.teamId", e.input("input.invitationId")),
    noResultYet: e.isNull("result.acceptedAt"),
    orderable: e.lt("self.email", 3),
    seatsMatch: e.eq("self.seats", e.input("seats")),
  },
  ensures: {
    accepted: e.eq("reslt.status", "accepted"),
    literalRef: e.eq("result.email", "input.email"),
    crossesList: db.exists("team", { members: { role: "owner" } }),
  },
  effects: ["db:write"],
});

export const Audit = action("Team.audit", {
  policy: OwnerOrAdmin,
  intent: "Look at the members list.",
  route: { method: "GET", path: "/teams/:teamId/members" },
  input: z.object({ teamId: z.string(), role: z.string() }),
  requires: {
    selfless: e.eq("self.name", "x"),
    isAdmin: async ({ input }) => input.role === "admin",
    fromEnv: e.eq("input.teamId", process.env.TEAM ?? "t"),
  },
  effects: [],
});

export const Settings = query("Team.settings", {
  intent: "Team settings.",
  route: { method: "GET", path: "/teams/:teamId/settings" },
  input: z.object({ teamId: z.string() }),
});

export const Stats = query("Team.stats", {
  intent: "Counts, and (wrongly) a write.",
  input: z.object({ teamId: z.string() }),
  policy: OwnerOrAdmin,
  run: async ({ input, db }) => {
    await db.team.update({ where: { id: input.teamId }, data: { name: "x" } });
    return db.invitation.count({ where: { teamId: input.teamId } });
  },
});

export const ttlSeconds = TTL;
