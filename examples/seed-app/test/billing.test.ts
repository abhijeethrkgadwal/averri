import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, signedStripeRequest, stripeEvent, type TestContext } from "./helpers.js";

describe("billing", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  describe("subscription and checkout", () => {
    it("GET billing shows the mirrored subscription to owners and admins only", async () => {
      const res = await ctx.request("GET", "/orgs/org_acme/billing", { as: "admin" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ organizationId: "org_acme", plan: "pro", status: "active", seats: 5, stripeCustomerId: "cus_seed_acme" });
      expect((await ctx.request("GET", "/orgs/org_acme/billing", { as: "member" })).status).toBe(403);
      expect((await ctx.request("GET", "/orgs/org_acme/billing")).status).toBe(401);
    });

    it("checkout is owner-only, creates the Stripe customer once and returns a session url", async () => {
      expect((await ctx.request("POST", "/orgs/org_globex/billing/checkout", { as: "owner", body: { plan: "pro" } })).status).toBe(403);
      expect((await ctx.request("POST", "/orgs/org_acme/billing/checkout", { as: "admin", body: { plan: "pro" } })).status).toBe(403);
      expect((await ctx.request("POST", "/orgs/org_globex/billing/checkout", { as: "otherAdmin", body: { plan: "gold" } })).status).toBe(400);

      const first = await ctx.request("POST", "/orgs/org_globex/billing/checkout", { as: "otherAdmin", body: { plan: "pro", seats: 3 } });
      expect(first.status).toBe(201);
      expect(first.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\/pay\//);
      expect(first.body.customerId).toMatch(/^cus_/);
      expect(ctx.stripe.customers_).toHaveLength(1);
      expect(ctx.stripe.sessions_.at(-1)).toMatchObject({ customer: first.body.customerId, metadata: { organizationId: "org_globex", plan: "pro", priceId: "price_pro", quantity: "3" } });

      const second = await ctx.request("POST", "/orgs/org_globex/billing/checkout", { as: "otherAdmin", body: { plan: "enterprise" } });
      expect(second.status).toBe(201);
      expect(second.body.customerId).toBe(first.body.customerId);
      expect(ctx.stripe.customers_).toHaveLength(1);
      const sub = await ctx.db.subscription.findUniqueOrThrow({ where: { organizationId: "org_globex" } });
      expect(sub.stripeCustomerId).toBe(first.body.customerId);
    });
  });

  describe("POST /webhooks/stripe", () => {
    it("rejects missing, malformed, tampered and stale signatures without touching the database", async () => {
      const event = stripeEvent("customer.subscription.updated", { id: "sub_x", customer: "cus_seed_acme", status: "past_due" });
      const signed = signedStripeRequest(ctx, event);

      const missing = await ctx.request("POST", "/webhooks/stripe", { rawBody: signed.rawBody });
      expect(missing.status).toBe(400);
      expect(missing.body.error.message).toContain("missing");

      const malformed = await ctx.request("POST", "/webhooks/stripe", { rawBody: signed.rawBody, headers: { "stripe-signature": "nonsense" } });
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.message).toContain("malformed");

      const tampered = await ctx.request("POST", "/webhooks/stripe", { rawBody: signed.rawBody.replace("past_due", "active"), headers: signed.headers });
      expect(tampered.status).toBe(400);
      expect(tampered.body.error.code).toBe("invalid_signature");
      expect(tampered.body.error.message).toContain("mismatch");

      const wrongSecret = signedStripeRequest(ctx, event, { secret: "whsec_other" });
      expect((await ctx.request("POST", "/webhooks/stripe", { rawBody: wrongSecret.rawBody, headers: wrongSecret.headers })).status).toBe(400);

      const stale = signedStripeRequest(ctx, event, { timestamp: Math.floor(ctx.clock.now.getTime() / 1000) - 301 });
      const staleRes = await ctx.request("POST", "/webhooks/stripe", { rawBody: stale.rawBody, headers: stale.headers });
      expect(staleRes.status).toBe(400);
      expect(staleRes.body.error.message).toContain("expired");

      expect(await ctx.db.webhookEvent.count()).toBe(0);
      expect((await ctx.db.subscription.findUniqueOrThrow({ where: { organizationId: "org_acme" } })).status).toBe("active");
    });

    it("verifies over the RAW body: non-canonical whitespace and key order still verify", async () => {
      const rawBody = `{ "type" : "customer.subscription.updated",\n  "data": {"object": {"status": "past_due", "customer": "cus_seed_acme", "id": "sub_seed_acme"}},   "id":"evt_raw_1" }`;
      const signed = signedStripeRequest(ctx, {}, { rawBody });
      const res = await ctx.request("POST", "/webhooks/stripe", { rawBody, headers: signed.headers });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, eventId: "evt_raw_1", duplicate: false, status: "processed" });
      const sub = await ctx.db.subscription.findUniqueOrThrow({ where: { organizationId: "org_acme" } });
      expect(sub.status).toBe("past_due");
      const stored = await ctx.db.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "stripe", eventId: "evt_raw_1" } } });
      expect(stored.payload).toBe(rawBody);
      expect(stored.status).toBe("processed");
    });

    it("is idempotent by event id: a replay returns 200 duplicate:true and leaves state unchanged", async () => {
      const event = stripeEvent(
        "customer.subscription.updated",
        {
          id: "sub_seed_acme",
          customer: "cus_seed_acme",
          status: "active",
          cancel_at_period_end: true,
          current_period_end: 1_800_000_000,
          items: { data: [{ quantity: 7, price: { id: "price_enterprise" } }] },
        },
        "evt_dup_1",
      );
      const signed = signedStripeRequest(ctx, event);
      const first = await ctx.request("POST", "/webhooks/stripe", { rawBody: signed.rawBody, headers: signed.headers });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ duplicate: false, status: "processed" });
      const snapshot = await ctx.db.subscription.findUniqueOrThrow({ where: { organizationId: "org_acme" } });
      expect(snapshot).toMatchObject({ status: "active", plan: "enterprise", seats: 7, cancelAtPeriodEnd: true, currentPeriodEnd: new Date(1_800_000_000 * 1000) });
      const auditBefore = await ctx.db.auditLog.count({ where: { organizationId: "org_acme" } });
      const eventsBefore = ctx.events.sent.length;

      // Replay the exact same delivery, and once more with a re-signed (fresh timestamp) copy.
      const replay = await ctx.request("POST", "/webhooks/stripe", { rawBody: signed.rawBody, headers: signed.headers });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ received: true, eventId: "evt_dup_1", duplicate: true, status: "processed" });
      ctx.clock.advance(10_000);
      const resigned = signedStripeRequest(ctx, event);
      expect((await ctx.request("POST", "/webhooks/stripe", { rawBody: resigned.rawBody, headers: resigned.headers })).body.duplicate).toBe(true);

      expect(await ctx.db.subscription.findUniqueOrThrow({ where: { organizationId: "org_acme" } })).toEqual(snapshot);
      expect(await ctx.db.auditLog.count({ where: { organizationId: "org_acme" } })).toBe(auditBefore);
      expect(ctx.events.sent.length).toBe(eventsBefore);
      expect(await ctx.db.webhookEvent.count({ where: { eventId: "evt_dup_1" } })).toBe(1);
    });

    it("emits SubscriptionChanged and writes an audit entry for processed events", async () => {
      const event = stripeEvent("invoice.payment_failed", { id: "in_1", customer: "cus_seed_acme" }, "evt_fail_1");
      const signed = signedStripeRequest(ctx, event);
      const res = await ctx.request("POST", "/webhooks/stripe", { rawBody: signed.rawBody, headers: signed.headers });
      expect(res.status).toBe(200);
      expect((await ctx.db.subscription.findUniqueOrThrow({ where: { organizationId: "org_acme" } })).status).toBe("past_due");
      expect(ctx.events.sent.at(-1)).toEqual({ name: "averri/SubscriptionChanged", data: { organizationId: "org_acme", eventId: "evt_fail_1", type: "invoice.payment_failed" } });
      const audit = await ctx.db.auditLog.findFirst({ where: { action: "billing.payment_failed" } });
      expect(audit).toMatchObject({ actorType: "webhook", actorId: "evt_fail_1", organizationId: "org_acme" });
    });

    it("subscription.deleted drops the organization back to free", async () => {
      const event = stripeEvent("customer.subscription.deleted", { id: "sub_seed_acme", customer: "cus_seed_acme", status: "canceled" });
      const signed = signedStripeRequest(ctx, event);
      expect((await ctx.request("POST", "/webhooks/stripe", { rawBody: signed.rawBody, headers: signed.headers })).status).toBe(200);
      const sub = await ctx.db.subscription.findUniqueOrThrow({ where: { organizationId: "org_acme" } });
      expect(sub).toMatchObject({ plan: "free", status: "canceled", seats: 1, stripeSubscriptionId: null, cancelAtPeriodEnd: false });
    });

    it("checkout.session.completed links the customer by organization metadata and activates the plan", async () => {
      const event = stripeEvent("checkout.session.completed", { id: "cs_1", customer: "cus_new_globex", subscription: "sub_new_globex", metadata: { organizationId: "org_globex", plan: "pro" } });
      const signed = signedStripeRequest(ctx, event);
      expect((await ctx.request("POST", "/webhooks/stripe", { rawBody: signed.rawBody, headers: signed.headers })).status).toBe(200);
      const sub = await ctx.db.subscription.findUniqueOrThrow({ where: { organizationId: "org_globex" } });
      expect(sub).toMatchObject({ plan: "pro", status: "active", stripeCustomerId: "cus_new_globex", stripeSubscriptionId: "sub_new_globex" });
    });

    it("unknown customers and unhandled types are acknowledged as ignored (no retry storm), still idempotently", async () => {
      const unknown = signedStripeRequest(ctx, stripeEvent("customer.subscription.updated", { id: "sub_zzz", customer: "cus_unknown", status: "active" }, "evt_unknown_1"));
      const res = await ctx.request("POST", "/webhooks/stripe", { rawBody: unknown.rawBody, headers: unknown.headers });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ duplicate: false, status: "ignored" });
      const stored = await ctx.db.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "stripe", eventId: "evt_unknown_1" } } });
      expect(stored).toMatchObject({ status: "ignored", error: "unknown_customer" });
      const again = await ctx.request("POST", "/webhooks/stripe", { rawBody: unknown.rawBody, headers: unknown.headers });
      expect(again.body).toMatchObject({ duplicate: true, status: "ignored" });

      const other = signedStripeRequest(ctx, stripeEvent("charge.refunded", { id: "ch_1" }, "evt_other_1"));
      const otherRes = await ctx.request("POST", "/webhooks/stripe", { rawBody: other.rawBody, headers: other.headers });
      expect(otherRes.body).toMatchObject({ status: "ignored" });
    });

    it("rejects bodies that are not Stripe events even when correctly signed", async () => {
      const notEvent = signedStripeRequest(ctx, {}, { rawBody: JSON.stringify({ hello: "world" }) });
      const res = await ctx.request("POST", "/webhooks/stripe", { rawBody: notEvent.rawBody, headers: notEvent.headers });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_event");
      const notJson = signedStripeRequest(ctx, {}, { rawBody: "not json" });
      expect((await ctx.request("POST", "/webhooks/stripe", { rawBody: notJson.rawBody, headers: notJson.headers })).body.error.code).toBe("malformed_json");
    });
  });
});
