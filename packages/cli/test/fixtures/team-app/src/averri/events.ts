// @ts-nocheck — fixture
import { event, workflow, integration } from "@averri/core";
import { inviteRunner } from "../jobs.js";
import { stripe } from "../stripe.js";

export const MemberInvited = event("MemberInvited", {
  intent: "An invitation was created or resent.",
  payload: { invitationId: "string", teamId: "string", email: "string" },
});

export const TeamRemoved = event("TeamRemoved", {
  payload: { teamId: "string" },
});

export const Audited = event("Audited", {
  payload: { what: "string" },
  external: true,
});

export const InviteFlow = workflow("InviteFlow", {
  intent: "Email the invitation link.",
  on: MemberInvited,
  runner: inviteRunner,
  retry: { attempts: 3, backoff: "fixed" },
});

export const Stripe = integration("Stripe", {
  intent: "Billing provider.",
  client: stripe,
  webhook: {
    verify: "stripe-signature",
    scheme: "stripe",
    secretEnv: "STRIPE_WEBHOOK_SECRET",
    rawBody: true,
    route: { method: "POST", path: "/webhooks/stripe" },
  },
  nonTransactional: true,
});
