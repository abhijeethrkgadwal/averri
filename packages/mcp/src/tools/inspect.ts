import { inspect } from "@averri/compiler";
import { z } from "zod";
import { defineTool } from "../define.js";

export const inputSchema = z.object({
  id: z.string(),
  include: z.array(z.enum(["source", "history", "tests"])).default([]),
});

export const inspectTool = defineTool(
  "inspect",
  "Everything about one node: payload, spec card, edges, dependents, diagnostics. Id or bare qualifier. Budget 2000 tokens.",
  inputSchema,
  ({ graph, input, ctx }) => inspect(graph, input, { root: ctx.root }),
);
