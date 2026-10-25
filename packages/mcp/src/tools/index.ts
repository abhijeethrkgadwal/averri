import type { ToolContext } from "../context.js";
import type { ToolDef } from "../define.js";
import { toolError, type ToolResponse } from "../envelope.js";
import { checkTool } from "./check.js";
import { explainTool } from "./explain.js";
import { findTool } from "./find.js";
import { impactTool } from "./impact.js";
import { inspectTool } from "./inspect.js";
import { overviewTool } from "./overview.js";
import { readSourceTool } from "./read_source.js";
import { suggestTool } from "./suggest.js";

export { overviewTool, findTool, inspectTool, impactTool, checkTool, explainTool, readSourceTool, suggestTool };
export { readSource } from "./read_source.js";
export { suggest } from "./suggest.js";

/** Tool order as in SPEC-MCP §6. */
export const TOOLS = [overviewTool, findTool, inspectTool, impactTool, checkTool, explainTool, readSourceTool, suggestTool] as unknown as readonly ToolDef[];

export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name);

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Run a tool by name with raw input; the CLI prints `serialize(result)` for `--json`. */
export async function callTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResponse<unknown>> {
  const tool = getTool(name);
  if (!tool) return toolError("bad-input", `unknown tool ${name}; tools: ${TOOL_NAMES.join(", ")}`);
  return tool.handler(input, ctx);
}
