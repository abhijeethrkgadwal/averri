/**
 * Billing: the subscription mirror of Stripe, the checkout entry point, and the webhook receiver.
 *
 * Webhook pitfalls handled on purpose (they are the benchmark's favourite agent mistakes):
 * - the signature is verified over the RAW body, never over re-serialised JSON;
 * - deliveries are idempotent by Stripe event id (`WebhookEvent` unique on `(provider, eventId)`), so
 *   a replay returns 200 without touching the subscription again;
 * - processing runs in one transaction with the idempotency row; a failure rolls everything back and
 *   answers 500 so Stripe retries, while unknown customers/types are acknowledged as `ignored`.
 */
import { z } from "zod";
import type { OrgAccess } from "../auth.js";
import type { AppDeps } from "../context.js";
import type { Tx } from "../db.js";
import { eventName } from "../events.js";
import { planSchema, type Plan, type SubscriptionStatus } from "../lib/constants.js";
import { errors, isUniqueViolation } from "../lib/errors.js";
import { verifyStripeSignature } from "../lib/stripe.js";
import { recordAudit } from "./audit.js";

export const STRIPE_PROVIDER = "stripe";

export const createCheckoutSchema = z.object({
  plan: z.enum(["pro", "enterprise"]),
  seats: z.number().int().min(1).max(500).default(1),
});

/** The subset of a Stripe event the receiver relies on; everything else passes through untouched. */
export const stripeEventSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int().optional(),
  data: z.looseObject({ object: z.looseObject({}) }),
});

export type StripeEvent = z.output<typeof stripeEventSchema>;

export function serializeSubscription(s: {
  id: string;
  organizationId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: string;
  status: string;
  seats: number;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: s.id,
    organizationId: s.organizationId,
    stripeCustomerId: s.stripeCustomerId,
    stripeSubscriptionId: s.stripeSubscriptionId,
    plan: s.plan,
    status: s.status,
    seats: s.seats,
    currentPeriodEnd: s.currentPeriodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * Read-only (a GET must not write; Averri's effect-scan reported the earlier lazy `upsert` as A4004).
 * Every organization gets its free subscription when it is created; one without a row (data created
 * before that rule) is shown the free plan without persisting anything.
 */
export async function getBilling(deps: AppDeps, orgId: string) {
  const subscription = await deps.db.subscription.findUnique({ where: { organizationId: orgId } });
  if (subscription !== null) return serializeSubscription(subscription);
  const now = deps.now();
  const freePlan = { id: "", organizationId: orgId, stripeCustomerId: null, stripeSubscriptionId: null, plan: "free", status: "active", seats: 1, currentPeriodEnd: null, cancelAtPeriodEnd: false, createdAt: now, updatedAt: now };
  return { ...serializeSubscription(freePlan), id: null };
}

export async function createCheckout(deps: AppDeps, access: OrgAccess, input: z.output<typeof createCheckoutSchema>) {
  const actor = access.actor;
  if (actor.type !== "user") throw errors.forbidden("user_required", "API keys cannot start a checkout");
  const subscription = await deps.db.subscription.upsert({
    where: { organizationId: access.org.id },
    create: { organizationId: access.org.id, plan: "free", status: "active", seats: 1 },
    update: {},
  });
  let customerId = subscription.stripeCustomerId;
  if (customerId === null) {
    // Network call outside any transaction (Averri A4005 would flag it inside one).
    const customer = await deps.stripe.customers.create({ email: actor.email, name: access.org.name, metadata: { organizationId: access.org.id } });
    customerId = customer.id;
    await deps.db.subscription.update({ where: { id: subscription.id }, data: { stripeCustomerId: customerId } });
  }
  const session = await deps.stripe.checkout.sessions.create({
    customer: customerId,
    priceId: deps.config.stripePrices[input.plan],
    quantity: input.seats,
    successUrl: `${deps.config.appBaseUrl}/orgs/${access.org.slug}/billing?checkout=success`,
    cancelUrl: `${deps.config.appBaseUrl}/orgs/${access.org.slug}/billing?checkout=cancel`,
    metadata: { organizationId: access.org.id, plan: input.plan },
  });
  await recordAudit(deps.db, { organizationId: access.org.id, actor, action: "billing.checkout_started", targetType: "subscription", targetId: subscription.id, metadata: { plan: input.plan, seats: input.seats, sessionId: session.id } });
  return { sessionId: session.id, url: session.url, customerId };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

const STRIPE_STATUS: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  paused: "past_due",
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function planFrom(object: Record<string, unknown>, priceToPlan: Record<string, Plan>): Plan | null {
  const metadata = object.metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const parsed = planSchema.safeParse((metadata as Record<string, unknown>).plan);
    if (parsed.success) return parsed.data;
  }
  const items = object.items;
  if (typeof items === "object" && items !== null) {
    const data = (items as { data?: unknown }).data;
    if (Array.isArray(data)) {
      for (const item of data) {
        const price = (item as { price?: { id?: unknown; lookup_key?: unknown } }).price;
        const key = str(price?.lookup_key) ?? str(price?.id);
        if (key !== null && priceToPlan[key] !== undefined) return priceToPlan[key] as Plan;
      }
    }
  }
  return null;
}

function seatsFrom(object: Record<string, unknown>): number | null {
  const items = object.items;
  if (typeof items === "object" && items !== null) {
    const data = (items as { data?: unknown }).data;
    if (Array.isArray(data)) {
      const total = data.reduce<number>((sum, item) => sum + (typeof (item as { quantity?: unknown }).quantity === "number" ? ((item as { quantity: number }).quantity) : 0), 0);
      if (total > 0) return total;
    }
  }
  return null;
}

export type WebhookOutcome = { status: "processed" | "ignored"; reason?: string; organizationId?: string };

async function applyStripeEvent(tx: Tx, deps: AppDeps, event: StripeEvent): Promise<WebhookOutcome> {
  const object = event.data.object as Record<string, unknown>;
  const priceToPlan: Record<string, Plan> = { [deps.config.stripePrices.pro]: "pro", [deps.config.stripePrices.enterprise]: "enterprise" };
  const customerId = str(object.customer);

  switch (event.type) {
    case "checkout.session.completed": {
      const metadata = (typeof object.metadata === "object" && object.metadata !== null ? object.metadata : {}) as Record<string, unknown>;
      const organizationId = str(metadata.organizationId);
      const subscription =
        organizationId !== null
          ? await tx.subscription.findUnique({ where: { organizationId } })
          : customerId !== null
            ? await tx.subscription.findUnique({ where: { stripeCustomerId: customerId } })
            : null;
      if (subscription === null) return { status: "ignored", reason: "unknown_organization" };
      const plan = planFrom(object, priceToPlan) ?? "pro";
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          stripeCustomerId: customerId ?? subscription.stripeCustomerId,
          stripeSubscriptionId: str(object.subscription) ?? subscription.stripeSubscriptionId,
          plan,
          status: "active",
        },
      });
      await recordAudit(tx, { organizationId: subscription.organizationId, actor: { type: "webhook", id: event.id }, action: "billing.checkout_completed", targetType: "subscription", targetId: subscription.id, metadata: { plan } });
      return { status: "processed", organizationId: subscription.organizationId };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      if (customerId === null) return { status: "ignored", reason: "missing_customer" };
      const subscription = await tx.subscription.findUnique({ where: { stripeCustomerId: customerId } });
      if (subscription === null) return { status: "ignored", reason: "unknown_customer" };
      const status = STRIPE_STATUS[str(object.status) ?? ""] ?? "incomplete";
      const plan = planFrom(object, priceToPlan);
      const seats = seatsFrom(object);
      const periodEnd = typeof object.current_period_end === "number" ? new Date(object.current_period_end * 1000) : null;
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          stripeSubscriptionId: str(object.id) ?? subscription.stripeSubscriptionId,
          status,
          ...(plan === null ? {} : { plan }),
          ...(seats === null ? {} : { seats }),
          ...(periodEnd === null ? {} : { currentPeriodEnd: periodEnd }),
          cancelAtPeriodEnd: object.cancel_at_period_end === true,
        },
      });
      await recordAudit(tx, { organizationId: subscription.organizationId, actor: { type: "webhook", id: event.id }, action: "billing.subscription_updated", targetType: "subscription", targetId: subscription.id, metadata: { status, plan, seats } });
      return { status: "processed", organizationId: subscription.organizationId };
    }
    case "customer.subscription.deleted": {
      if (customerId === null) return { status: "ignored", reason: "missing_customer" };
      const subscription = await tx.subscription.findUnique({ where: { stripeCustomerId: customerId } });
      if (subscription === null) return { status: "ignored", reason: "unknown_customer" };
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { status: "canceled", plan: "free", seats: 1, cancelAtPeriodEnd: false, stripeSubscriptionId: null },
      });
      await recordAudit(tx, { organizationId: subscription.organizationId, actor: { type: "webhook", id: event.id }, action: "billing.subscription_canceled", targetType: "subscription", targetId: subscription.id });
      return { status: "processed", organizationId: subscription.organizationId };
    }
    case "invoice.payment_failed": {
      if (customerId === null) return { status: "ignored", reason: "missing_customer" };
      const subscription = await tx.subscription.findUnique({ where: { stripeCustomerId: customerId } });
      if (subscription === null) return { status: "ignored", reason: "unknown_customer" };
      await tx.subscription.update({ where: { id: subscription.id }, data: { status: "past_due" } });
      await recordAudit(tx, { organizationId: subscription.organizationId, actor: { type: "webhook", id: event.id }, action: "billing.payment_failed", targetType: "subscription", targetId: subscription.id });
      return { status: "processed", organizationId: subscription.organizationId };
    }
    default:
      return { status: "ignored", reason: "unhandled_type" };
  }
}

export interface WebhookResult {
  received: true;
  eventId: string;
  duplicate: boolean;
  status: "processed" | "ignored";
}

/**
 * Receive one Stripe webhook delivery. `rawBody` is the unparsed request body the signature was
 * computed over. Returns the recorded outcome; throws AppError 400 for signature/shape problems.
 */
export async function handleStripeWebhook(deps: AppDeps, rawBody: string, signatureHeader: string | undefined): Promise<WebhookResult> {
  const verification = verifyStripeSignature(signatureHeader, rawBody, deps.config.stripeWebhookSecret, { now: deps.now });
  if (!verification.ok) {
    throw errors.badRequest("invalid_signature", `Webhook signature verification failed (${verification.reason})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw errors.badRequest("malformed_json", "Webhook body is not valid JSON");
  }
  const parsed = stripeEventSchema.safeParse(json);
  if (!parsed.success) throw errors.badRequest("invalid_event", "Webhook body is not a Stripe event", parsed.error.issues);
  const event = parsed.data;

  let outcome: WebhookOutcome;
  try {
    outcome = await deps.db.$transaction(async (tx) => {
      // The idempotency row is written FIRST inside the transaction: a duplicate delivery fails here
      // with P2002 before any side effect, and a processing failure rolls the row back so Stripe retries.
      await tx.webhookEvent.create({
        data: { provider: STRIPE_PROVIDER, eventId: event.id, type: event.type, payload: rawBody, status: "processed" },
      });
      const result = await applyStripeEvent(tx, deps, event);
      await tx.webhookEvent.update({
        where: { provider_eventId: { provider: STRIPE_PROVIDER, eventId: event.id } },
        data: { status: result.status, error: result.reason ?? null, processedAt: deps.now() },
      });
      return result;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await deps.db.webhookEvent.findUnique({ where: { provider_eventId: { provider: STRIPE_PROVIDER, eventId: event.id } } });
      return { received: true, eventId: event.id, duplicate: true, status: existing?.status === "ignored" ? "ignored" : "processed" };
    }
    throw error;
  }
  if (outcome.status === "processed" && outcome.organizationId !== undefined) {
    await deps.events.send({ name: eventName("SubscriptionChanged"), data: { organizationId: outcome.organizationId, eventId: event.id, type: event.type } });
  }
  return { received: true, eventId: event.id, duplicate: false, status: outcome.status };
}
