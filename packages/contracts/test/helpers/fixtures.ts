/**
 * Shared declarations and config for the contracts tests: the SPEC-DECLARATIONS §4 worked example
 * (Invitation, Team.OwnerOrAdmin, MemberInvited, Team.inviteMember) plus seed tables for the fake client.
 */
import { z } from "zod";
import { action, db, defineConfig, e, entity, event, policy, type ActionContext, type AnyActionDecl, type AverriConfig } from "@averri/core";
import type { Row } from "../../src/index.js";

export const Invitation = entity("Invitation", {
  owner: "team-platform",
  invariant: { pendingHasNoAcceptedAt: e.or(e.ne("status", "pending"), e.isNull("acceptedAt")) },
});

export const OwnerOrAdmin = policy("Team.OwnerOrAdmin", {
  intent: "Owners and admins manage membership; members cannot.",
  allow: db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }),
});

export const MemberInvited = event("MemberInvited", {
  payload: { invitationId: "string", teamId: "string", email: "string" },
});

export const inviteInput = z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) });
export type InviteInput = z.output<typeof inviteInput>;

export const inviteRoute = { method: "POST", path: "/teams/:teamId/invitations" } as const;

/** The emitter target the observe spy wraps and the declared-mode `publish` bridge. */
export const bus = {
  sent: [] as unknown[],
  send(payload: unknown): Promise<void> {
    bus.sent.push(payload);
    return Promise.resolve();
  },
};
export const published: Array<{ name: string; payload: Record<string, unknown> }> = [];
export let publishError: Error | null = null;
export function setPublishError(error: Error | null): void {
  publishError = error;
}
export function resetBus(): void {
  bus.sent.length = 0;
  published.length = 0;
  publishError = null;
}

export const config: AverriConfig = defineConfig({
  entryPoints: ["src/app.ts"],
  actors: {
    anonymous: { actor: null },
    member: { actor: { id: "u_member", orgId: "o1", role: "member" }, headers: { authorization: "Bearer member" } },
    otherTeamAdmin: { actor: { id: "u_other", orgId: "o2", role: "admin" }, headers: { authorization: "Bearer other" } },
    admin: { actor: { id: "u_admin", orgId: "o1", role: "admin" }, headers: { authorization: "Bearer admin" } },
  },
  emitter: {
    eventNamePrefix: "averri/",
    publish: async (name, payload) => {
      if (publishError) throw publishError;
      published.push({ name, payload });
    },
    spy: { target: bus, method: "send" },
  },
});

export const actors = {
  admin: config.actors.admin!.actor!,
  member: config.actors.member!.actor!,
  other: config.actors.otherTeamAdmin!.actor!,
};

export function seedTables(): Record<string, Row[]> {
  return {
    membership: [
      { id: "m1", teamId: "t1", userId: "u_admin", role: "admin", user: { id: "u_admin", email: "admin@acme.io" } },
      { id: "m2", teamId: "t1", userId: "u_member", role: "member", user: { id: "u_member", email: "member@acme.io" } },
      { id: "m3", teamId: "t2", userId: "u_other", role: "admin", user: { id: "u_other", email: "other@acme.io" } },
    ],
    invitation: [{ id: "inv_old", teamId: "t1", email: "pending@acme.io", role: "member", status: "pending", acceptedAt: null, createdAt: new Date("2026-01-01T00:00:00.000Z") }],
    team: [{ id: "t1", name: "Acme", maxMembers: 10 }],
  };
}

export type RunFn = (ctx: ActionContext<typeof inviteInput, { id: string; orgId: string; role: string }>) => Promise<unknown>;

export const defaultRun: RunFn = async ({ input, actor, tx, emit }) => {
  const invitation = tx as unknown as { invitation: { create(args: { data: Row }): Promise<Row> } };
  const inv = await invitation.invitation.create({
    data: { teamId: input.teamId, email: input.email, role: input.role, invitedBy: actor.id, status: "pending", acceptedAt: null, createdAt: new Date("2026-10-24T10:00:00.000Z") },
  });
  emit(MemberInvited, { invitationId: String(inv.id), teamId: String(inv.teamId), email: String(inv.email) });
  return inv;
};

export interface InviteOverrides {
  run?: RunFn;
  transaction?: boolean | { timeout?: number; maxWait?: number };
  requires?: Record<string, unknown>;
  ensures?: Record<string, unknown>;
  subject?: unknown;
  output?: unknown;
  public?: true;
  route?: typeof inviteRoute;
}

/** The worked example in declared mode, with hooks to vary each phase. */
export function inviteMember(overrides: InviteOverrides = {}): AnyActionDecl {
  const base: Record<string, unknown> = {
    intent: "An owner or admin invites a person by email.",
    route: overrides.route ?? inviteRoute,
    input: inviteInput,
    output: overrides.output ?? Invitation,
    requires: overrides.requires ?? {
      notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),
      emailDomainAllowed: async ({ input }: { input: InviteInput }) => input.email.endsWith("@acme.io"),
    },
    ensures: overrides.ensures ?? {
      pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
      eventEmitted: e.emitted(MemberInvited, 1),
    },
    effects: ["db:write", "event:emit"],
    run: overrides.run ?? defaultRun,
  };
  if (overrides.public) base.public = true;
  else base.policy = OwnerOrAdmin;
  if (overrides.transaction !== undefined) base.transaction = overrides.transaction;
  if (overrides.subject !== undefined) base.subject = overrides.subject;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return action("Team.inviteMember" as const, base as any) as AnyActionDecl;
}

export const validInput: InviteInput = { teamId: "t1", email: "new@acme.io", role: "member" };
