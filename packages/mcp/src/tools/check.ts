import { check } from "@averri/compiler";
import { z } from "zod";
import { defineTool } from "../define.js";

export const inputSchema = z.object({
  scope: z.enum(["affected", "all"]).default("affected"),
  diffBase: z.string().optional(),
  acknowledgeWeakening: z.boolean().default(false),
});

export const checkTool = defineTool(
  "check",
  "Typecheck, compiler diagnostics and affected tests in one structured result. Use instead of raw tsc/vitest. Budget 2000 tokens.",
  inputSchema,
  async ({ input, ctx }) => {
    const r = await check(ctx.root, {
      scope: input.scope,
      acknowledgeWeakening: input.acknowledgeWeakening,
      ...(input.diffBase !== undefined ? { diffBase: input.diffBase } : {}),
      ...ctx.check,
    });
    return { ok: true, data: r.data, truncated: r.truncated, ...(r.more ? { more: r.more } : {}) };
  },
);
