/**
 * Dependency container and the Hono environment type. Everything a service needs arrives through
 * `AppDeps` so tests can inject an isolated database, a fresh event bus, an in-memory mailer and a
 * fake Stripe client (see `test/helpers.ts`).
 */
import type { Context } from "hono";
import type { PrismaClient } from "./db.js";
import type { EventBus } from "./events.js";
import type { Mailer } from "./lib/mailer.js";
import type { StripeClient } from "./lib/stripe.js";
import type { Actor } from "./auth.js";

export interface AppConfig {
  /** Secret used to verify `stripe-signature` headers. */
  stripeWebhookSecret: string;
  /** Stripe price ids per paid plan (checkout). */
  stripePrices: { pro: string; enterprise: string };
  /** Base URL of the frontend, used for invitation links and checkout redirects. */
  appBaseUrl: string;
}

export interface AppDeps {
  db: PrismaClient;
  events: EventBus;
  mailer: Mailer;
  stripe: StripeClient;
  config: AppConfig;
  /** Injectable clock so tests can control expiry and signature tolerance. */
  now: () => Date;
}

export type AppEnv = {
  Variables: {
    deps: AppDeps;
    actor: Actor | null;
  };
};

export type AppContext = Context<AppEnv>;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "whsec_dev_secret",
    stripePrices: { pro: env.STRIPE_PRICE_PRO ?? "price_pro", enterprise: env.STRIPE_PRICE_ENTERPRISE ?? "price_enterprise" },
    appBaseUrl: env.APP_BASE_URL ?? "http://localhost:3000",
  };
}
