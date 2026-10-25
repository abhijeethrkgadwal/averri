import type { Context } from "hono";
import { UpdateTeam } from "./schemas.js";

export const listTeams = (c: Context) => c.json([]);

export async function removeMember(c: Context) {
  return c.json({ removed: c.req.param("userId") });
}

export const exportTeam = (c: Context) => c.text("csv");

export const stripeWebhook = async (c: Context) => c.text("ok");

export async function updateTeam(c: Context) {
  const body = UpdateTeam.parse(await c.req.json());
  return c.json(body);
}
