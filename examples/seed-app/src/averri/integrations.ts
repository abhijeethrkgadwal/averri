import { integration } from "@averri/core";
import { stripe } from "../lib/stripe.js";

export const Stripe = integration("Stripe", {
  intent: "Billing provider. Customers and checkout sessions are created through the client; subscription state arrives through the webhook.",
  client: stripe,
  webhook: {
    verify: "stripe-signature",
    scheme: "stripe",
    secretEnv: "STRIPE_WEBHOOK_SECRET",
    rawBody: true,
    route: { method: "POST", path: "/webhooks/stripe" },
  },
  idempotency: { key: { input: "id" }, ttlSeconds: 30 * 24 * 60 * 60 },
  nonTransactional: true,
  effects: ["network"],
  owner: "team-billing",
});

export const integrations = [Stripe] as const;
