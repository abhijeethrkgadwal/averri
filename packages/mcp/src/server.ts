/**
 * The MCP server (SPEC-MCP §2): tools generated from the zod input schemas with `z.toJSONSchema`,
 * resources for construct docs and node cards, stdio and streamable-HTTP transports.
 */

import * as http from "node:http";
import { loadOrBuild, renderCardMarkdown, resolveNodeId } from "@averri/compiler";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { CARD_URI_PREFIX, DOC_NAMES, DOC_URI_PREFIX, docText, docUri } from "./docs.js";
import { serialize } from "./envelope.js";
import { callTool, TOOLS } from "./tools/index.js";

export const SERVER_NAME = "averri";
export const SERVER_VERSION = "0.0.1";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool definitions: `inputSchema` is `z.toJSONSchema` of the tool's zod schema (root `type: "object"`). */
export function toolDescriptors(): ToolDescriptor[] {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.inputSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

export function createServer(ctx: ToolContext): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDescriptors() as never }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(req.params.name, req.params.arguments ?? {}, ctx);
    return { content: [{ type: "text" as const, text: serialize(result) }], isError: !result.ok };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: DOC_NAMES.map((name) => ({
      uri: docUri(name),
      name: `averri docs: ${name}`,
      description: name === "core" ? "Core card: observe-mode example, reference roots, literal lists" : `Semantics card for ${name}`,
      mimeType: "text/markdown",
    })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: `${CARD_URI_PREFIX}{id}`, name: "averri node card", description: "Markdown spec card for one node (URI-encoded NodeId or bare qualifier)", mimeType: "text/markdown" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri.startsWith(DOC_URI_PREFIX)) {
      const text = docText(uri.slice(DOC_URI_PREFIX.length));
      if (text === null) throw new McpError(ErrorCode.InvalidParams, `unknown docs resource ${uri}; known: ${DOC_NAMES.join(", ")}`);
      return { contents: [{ uri, mimeType: "text/markdown", text }] };
    }
    if (uri.startsWith(CARD_URI_PREFIX)) {
      let raw: string;
      try {
        raw = decodeURIComponent(uri.slice(CARD_URI_PREFIX.length));
      } catch {
        throw new McpError(ErrorCode.InvalidParams, `malformed card uri ${uri}`);
      }
      let graph;
      try {
        graph = await loadOrBuild(ctx.root, ctx.load);
      } catch (e) {
        throw new McpError(ErrorCode.InternalError, `build-failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const r = resolveNodeId(graph, raw);
      if (!r.ok) throw new McpError(ErrorCode.InvalidParams, `${r.error}: ${raw}${r.candidates.length ? ` (candidates: ${r.candidates.slice(0, 10).join(", ")})` : ""}`);
      const md = renderCardMarkdown(graph, r.id);
      if (md === null) throw new McpError(ErrorCode.InvalidParams, `${r.id} has no spec card (cards exist for Actions, Queries, Policies, Entities and Events)`);
      return { contents: [{ uri, mimeType: "text/markdown", text: md }] };
    }
    throw new McpError(ErrorCode.InvalidParams, `unknown resource ${uri}`);
  });

  return server;
}

/** `averri mcp`: serve over stdio until the transport closes. */
export async function runStdio(ctx: ToolContext): Promise<Server> {
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  return server;
}

export interface HttpHandle {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

/**
 * `averri mcp --http <port>`: stateless streamable HTTP on `/mcp` (one server + transport per request).
 * Binds to 127.0.0.1 unless `host` is given.
 */
export async function runHttp(ctx: ToolContext, port: number, host = "127.0.0.1"): Promise<HttpHandle> {
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found; the endpoint is /mcp" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }));
        return;
      }
      const server = createServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: e instanceof Error ? e.message : String(e) }, id: null }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const addr = httpServer.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  return {
    server: httpServer,
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
