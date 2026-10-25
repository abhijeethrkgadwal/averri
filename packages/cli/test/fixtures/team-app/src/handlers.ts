// @ts-nocheck — fixture
import { prisma } from "./db.js";

export async function inviteMemberHandler(c) {
  const body = await c.req.json();
  const inv = await prisma.invitation.create({ data: { teamId: c.req.param("teamId"), email: body.email, role: body.role } });
  return c.json(inv, 201);
}

export async function listInvitationsHandler(c) {
  const rows = await prisma.invitation.findMany({ where: { teamId: c.req.param("teamId") } });
  return c.json(rows);
}
