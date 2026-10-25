import { Hono } from "hono";
import { z } from "zod";
import { requireOrgRole } from "../auth.js";
import type { AppEnv } from "../context.js";
import { idSchema } from "../lib/constants.js";
import { parseBody, parseParams } from "../lib/validation.js";
import { createCheckout, createCheckoutSchema, getBilling, handleStripeWebhook } from "../services/billing.js";

const orgParams = z.object({ orgId: idSchema });

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.get("/orgs/:orgId/billing", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner", "admin"]);
  return c.json(await getBilling(c.get("deps"), orgId));
});

billingRoutes.post("/orgs/:orgId/billing/checkout", async (c) => {
  const { orgId } = parseParams(c, orgParams);
  const access = await requireOrgRole(c.get("deps"), c.get("actor"), orgId, ["owner"]);
  const input = await parseBody(c, createCheckoutSchema);
  return c.json(await createCheckout(c.get("deps"), access, input), 201);
});

/**
 * Stripe webhook receiver. Public by design (Stripe is not a user); authenticity comes from the
 * `stripe-signature` HMAC over the RAW body, which is why this handler reads `c.req.text()` and never
 * `c.req.json()` before verifying.
 */
billingRoutes.post("/webhooks/stripe", async (c) => {
  const rawBody = await c.req.text();
  const result = await handleStripeWebhook(c.get("deps"), rawBody, c.req.header("stripe-signature"));
  return c.json(result);
});
