// @ts-nocheck — fixture
import { Hono } from "hono";

export const webhookRoutes = new Hono();

webhookRoutes.post("/webhooks/stripe", async (c) => {
  const event = await c.req.json();
  const signature = c.req.header("stripe-signature");
  return c.json({ received: true, signature, type: event.type });
});
