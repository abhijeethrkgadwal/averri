// @ts-nocheck — copied from examples/seed-app for @averri/compiler tests
/**
 * InviteFlow: when a member is invited, email them the invitation link. Bound to the
 * `"averri/MemberInvited"` event; Averri declares it as the `InviteFlow` workflow (see `src/averri/workflows.ts`).
 */
import { defineJob } from "../lib/jobs.js";

export interface MemberInvitedData extends Record<string, unknown> {
  invitationId: string;
  organizationId: string;
  email: string;
  token: string;
}

export const inviteFlow = defineJob<MemberInvitedData>({
  id: "invite-flow",
  event: "averri/MemberInvited",
  retry: { attempts: 3, backoff: "fixed" },
  async run({ event, step, deps }) {
    const invitation = await step.run("load", async () => {
      const row = await deps.db.invitation.findUnique({
        where: { id: event.data.invitationId },
        include: { organization: { select: { name: true } }, invitedBy: { select: { name: true } } },
      });
      if (row === null) throw new Error(`invitation ${event.data.invitationId} not found`);
      return row;
    });
    await step.run("email", () =>
      deps.mailer.send({
        to: invitation.email,
        subject: `${invitation.invitedBy.name} invited you to ${invitation.organization.name}`,
        text: `Join ${invitation.organization.name} as ${invitation.role}: ${deps.config.appBaseUrl}/invitations/${invitation.token}`,
        template: "invitation",
        data: { invitationId: invitation.id, organizationId: invitation.organizationId, role: invitation.role, token: invitation.token },
      }),
    );
  },
});
