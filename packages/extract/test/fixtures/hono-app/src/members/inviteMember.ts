import type { Context } from "hono";
import { z } from "zod";

export const InviteMember = {
  input: z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) }),
  handler: async (c: Context) => {
    return c.json({ invited: true });
  },
};

export async function inviteMember(c: Context) {
  return InviteMember.handler(c);
}
