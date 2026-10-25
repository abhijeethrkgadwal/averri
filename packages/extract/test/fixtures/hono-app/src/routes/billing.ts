import { Hono } from "hono";
import { stripeWebhook } from "../handlers.js";

const billing = new Hono()
  .post("/webhook", stripeWebhook)
  .get("/plans", (c) => c.json([]));

export default billing;
