/**
 * Test helpers: the compiler's `team-app` fixture is copied under `packages/mcp/test/.tmp/` (gitignored)
 * so module resolution walks up to the monorepo's node_modules, and so tests can mutate files and write
 * `.averri/` freely. The fixture is only read, never modified.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ToolContext } from "../src/index.js";

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.join(TEST_DIR, "..", "..", "compiler", "test", "fixtures", "team-app");
export const TMP = path.join(TEST_DIR, ".tmp");
export const BUILD_TIMEOUT = 120_000;

export interface Project {
  root: string;
  ctx: ToolContext;
  write(rel: string, content: string): void;
  read(rel: string): string;
  edit(rel: string, from: string, to: string): void;
  cleanup(): void;
}

let counter = 0;

export function copyProject(): Project {
  fs.mkdirSync(TMP, { recursive: true });
  const root = path.join(TMP, `team-app-${process.pid}-${Date.now().toString(36)}-${counter++}`);
  fs.cpSync(FIXTURE, root, { recursive: true });
  return {
    root,
    ctx: { root, load: { git: false }, check: { tsc: false, vitest: false, git: false } },
    write(rel, content) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    },
    read: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
    edit(rel, from, to) {
      const file = path.join(root, rel);
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes(from)) throw new Error(`${rel} does not contain ${JSON.stringify(from)}`);
      fs.writeFileSync(file, text.replace(from, to));
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export interface Connected {
  client: Client;
  close(): Promise<void>;
}

/** An in-process MCP client connected to a server for `ctx` through the SDK's InMemoryTransport. */
export async function connect(ctx: ToolContext): Promise<Connected> {
  const server = createServer(ctx);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface Called {
  text: string;
  isError: boolean;
  json: any;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = r.content[0]?.text ?? "";
  return { text, isError: r.isError === true, json: JSON.parse(text) };
}

export const tokens = (v: unknown): number => Math.ceil(JSON.stringify(v).length / 4);
