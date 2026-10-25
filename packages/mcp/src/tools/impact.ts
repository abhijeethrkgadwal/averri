import { impactQuery } from "@averri/compiler";
import { z } from "zod";
import { countGiven, defineTool } from "../define.js";

export const inputSchema = z
  .object({
    id: z.string().optional(),
    diff: z.string().min(1).optional(),
    base: z.string().optional(),
  })
  .refine((v) => countGiven(v, ["id", "diff", "base"]) <= 1, { message: "pass at most one of id, diff, base" });

export const impactTool = defineTool(
  "impact",
  "What breaks if a node, a diff, or your uncommitted edits change: affected nodes, tests to run, weakened contracts. Budget 1500 tokens.",
  inputSchema,
  ({ graph, input, ctx }) => impactQuery(graph, input, { root: ctx.root, ...(ctx.load?.git === false ? { git: false } : {}) }),
);
