# @averri/mcp

The agent interface (SPEC-MCP): an MCP server (stdio and streamable HTTP) and the tool implementations as plain async functions.

- Tools: `overview`, `find`, `inspect`, `impact`, `check`, `explain`, `read_source`, `suggest`. Each module in `src/tools/` exports `{ name, description, inputSchema, handler(input, ctx) }`. Handlers parse raw input with the zod schema, call `@averri/compiler` `loadOrBuild` (never stale), and return the envelope or a `ToolError`.
- CLI reuse: `callTool(name, input, { root })` then `serialize(result)` gives the exact JSON the MCP server sends.
- Server: `createServer(ctx)`, `runStdio(ctx)`, `runHttp(ctx, port)` (POST `/mcp`, stateless, 127.0.0.1).
- Resources: `averri://docs/<core|entity|policy|action|query|event|workflow|integration|contracts|identity|tests|graph|check|config>` and `averri://card/<NodeId>`.
- Agent block for `averri init`: `agentBlock()`, `upsertAgentBlock(existing)`, `AGENT_BLOCK_FILES`, `mcpServerRegistration()`.
- Helpers: `bound(data, budget, dropOrder)`, `envelope`, `toolError`, `isIgnored` (.gitignore matcher).

Tests drive the server in-process with `InMemoryTransport` against a copy of the compiler's `team-app` fixture.
