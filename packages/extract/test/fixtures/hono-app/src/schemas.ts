import { z } from "zod";

export const Base = z.object({ teamId: z.string(), email: z.string().email() });

export const InviteInput = Base.extend({ role: z.enum(["admin", "member"]) }).strict();

export const UpdateTeam = z
  .object({
    name: z.string().min(1),
    slug: z.string().optional(),
  })
  .partial();

export const Merged = Base.merge(z.object({ note: z.string() }));

export const Picked = InviteInput.pick({ email: true });

export const Omitted = InviteInput.omit({ teamId: true });

const Internal = z.object({ secret: z.string() });
export { Internal as Exposed };

export const List = z.array(Base);

const extraShape = { note: z.string() };
export const Spread = z.object({ ...extraShape, extra: z.string() });

export const NotZod = { teamId: "x" };
