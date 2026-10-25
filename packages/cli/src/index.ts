/** @averri/cli: the `averri` command line. `run(argv, io)` is the programmatic entry point. */

export { run, createProgram, type RunOptions } from "./cli.js";
export { EXIT_OK, EXIT_DIAGNOSTICS, EXIT_USAGE, processIo, UsageError, type Io } from "./io.js";
export { runTool, exitCodeOf, serialize, TOOL_NAMES, NODE_KINDS, type Envelope, type ToolError, type ToolResponse, type ToolName, type ToolContext } from "./tools.js";
export { init, configTemplate, mcpSnippets, AVERRI_DTS, type InitOptions, type InitResult } from "./commands/init.js";
export { fmt, formatSourceFile, canonicalKeyOrder, type FmtOptions, type FmtResult, type FmtChange } from "./commands/fmt.js";
export { docs, docsFromGraph, renderSpecFile, type DocsOptions, type DocsResult } from "./commands/docs.js";
export { report, buildReport, type Report, type ReportResult } from "./commands/report.js";
export { testgen, type TestgenResult } from "./commands/testgen.js";
