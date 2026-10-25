import { overview } from "@averri/compiler";
import { z } from "zod";
import { defineTool } from "../define.js";

export const inputSchema = z.object({});

export const overviewTool = defineTool(
  "overview",
  "Session orientation: stack, node counts, health, top modules, quickstart. Call once per session. Budget 1200 tokens.",
  inputSchema,
  ({ graph }) => ({ ok: true, ...overview(graph) }),
);
