import { explain } from "@averri/compiler";
import { z } from "zod";
import { countGiven, defineTool } from "../define.js";

export const inputSchema = z
  .object({
    testId: z.string().optional(),
    diagId: z.string().optional(),
    diag: z.object({ code: z.string(), node: z.string() }).optional(),
    traceId: z.string().optional(),
    detail: z.enum(["summary", "full"]).default("summary"),
  })
  .refine((v) => countGiven(v, ["testId", "diagId", "diag", "traceId"]) === 1, { message: "pass exactly one of testId, diagId, diag, traceId" });

export const explainTool = defineTool(
  "explain",
  "Why a test, diagnostic or trace failed: actual vs expected, triggering input, declaration chain, changes since last green. Budget 1500 tokens.",
  inputSchema,
  ({ graph, input, ctx }) => explain(graph, input, { root: ctx.root }),
);
