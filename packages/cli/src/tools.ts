/**
 * The tool layer behind `averri <tool> --json` (SPEC-MCP §9): there is none of our own. Every tool
 * module lives in `@averri/mcp` and `--json` prints `serialize(callTool(...))`, i.e. the byte-identical
 * text the MCP server sends. This file only maps a response to a process exit code.
 */

import { TOOL_NAMES, callTool, serialize, type ToolContext, type ToolResponse } from "@averri/mcp";

export { TOOL_NAMES, serialize, type ToolContext, type ToolResponse };
export type { Envelope, ToolError } from "@averri/mcp";

export const NODE_KINDS = ["Entity", "Field", "Policy", "Action", "Query", "Exposure", "Event", "Workflow", "Integration", "Contract", "Test", "Module"] as const;

export type ToolName = "overview" | "find" | "inspect" | "impact" | "check" | "explain" | "read_source" | "suggest";

/** Run one tool; never throws. */
export function runTool(name: ToolName, input: unknown, ctx: ToolContext): Promise<ToolResponse<unknown>> {
  return callTool(name, input, ctx);
}

/** Process exit code for a tool response: 0 ok, 1 domain failure (not-found, build-failed, ...), 2 bad input. */
export function exitCodeOf(r: ToolResponse<unknown>): number {
  if (r.ok) return 0;
  return r.error === "bad-input" ? 2 : 1;
}
