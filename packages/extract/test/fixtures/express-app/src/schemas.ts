import { z } from "zod";

export const InviteInput = z.object({ teamId: z.string(), email: z.string().email(), role: z.string() });
