import { find } from "@averri/compiler";
import { NODE_KINDS } from "@averri/ir";
import { z } from "zod";
import { defineTool } from "../define.js";

export const inputSchema = z.object({
  query: z.string().min(1),
  kind: z.enum(NODE_KINDS).optional(),
  limit: z.number().int().min(1).max(30).default(20),
});

export const findTool = defineTool(
  "find",
  "Locate graph nodes by name or meaning (ids, routes, intent); not source text, use grep for that. Budget 800 tokens.",
  inputSchema,
  ({ graph, input }) => ({ ok: true, ...find(graph, { query: input.query, ...(input.kind ? { kind: input.kind } : {}), limit: input.limit }) }),
);
