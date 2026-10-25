/**
 * @averri/mcp: the agent interface (SPEC-MCP). Tool implementations are plain async functions
 * (`overviewTool.handler(input, ctx)`, `callTool(name, input, ctx)`) that the CLI reuses without MCP;
 * `createServer`/`runStdio`/`runHttp` expose the same tools over MCP.
 */

export type { ToolContext } from "./context.js";
export { defineTool, countGiven, type ToolDef, type ToolRun } from "./define.js";
export { bound, envelope, serialize, toolError, tokensOf, type DropStep, type Envelope, type Outcome, type ToolError, type ToolErrorCode, type ToolResponse } from "./envelope.js";
export { isIgnored, parseGitignore } from "./gitignore.js";
export { DOCS, DOC_BUDGETS, DOC_NAMES, docText, docUri, CARD_URI_PREFIX, DOC_URI_PREFIX } from "./docs.js";
export { AGENT_BLOCK_BEGIN, AGENT_BLOCK_END, AGENT_BLOCK_FILES, AGENT_BLOCK_LINES, agentBlock, upsertAgentBlock, mcpServerRegistration } from "./agent-block.js";
export { createServer, runStdio, runHttp, toolDescriptors, SERVER_NAME, SERVER_VERSION, type HttpHandle, type ToolDescriptor } from "./server.js";
export {
  TOOLS,
  TOOL_NAMES,
  getTool,
  callTool,
  overviewTool,
  findTool,
  inspectTool,
  impactTool,
  checkTool,
  explainTool,
  readSourceTool,
  suggestTool,
  readSource,
  suggest,
} from "./tools/index.js";
export type { ReadSourceData } from "./tools/read_source.js";
export type { Proposal } from "./tools/suggest.js";
export { READ_SOURCE_BUDGET } from "./tools/read_source.js";
export { SUGGEST_BUDGET } from "./tools/suggest.js";
