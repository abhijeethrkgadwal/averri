/**
 * `averri init` (SPEC-MCP §2, §8; the block text and the marker logic come from @averri/mcp): writes `averri.config.ts` and `src/averri.d.ts` when missing, installs
 * the agent block into CLAUDE.md, AGENTS.md and .cursor/rules/averri.mdc (idempotent, between markers),
 * adds the devDependencies generated tests import to package.json (no install is run), and returns the
 * MCP registration snippets for the caller to print.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_BLOCK_BEGIN, AGENT_BLOCK_END, mcpServerRegistration, upsertAgentBlock } from "@averri/mcp";

export const CURSOR_FRONTMATTER = ["---", "description: Averri contracts and semantic graph", "alwaysApply: true", "---", ""].join("\n");

export interface InitOptions {
  /** Skip editing package.json. */
  packageJson?: boolean;
  /** Overwrite `averri.config.ts` / `src/averri.d.ts` when present (default: leave them alone). */
  force?: boolean;
}

export interface InitResult {
  root: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** `npm install` command to run for the added devDependencies, or null. */
  install: string | null;
  mcp: McpSnippets;
}

export interface McpSnippets {
  claudeCode: string;
  mcpJson: string;
  cursor: string;
  http: string;
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

function write(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function detectEntryPoints(root: string): string[] {
  return ["src/app.ts", "src/index.ts", "src/server.ts", "src/main.ts"].filter((f) => exists(root, f)).slice(0, 2);
}

function detectPrismaSchema(root: string): string {
  return exists(root, "prisma/schema.prisma") ? "prisma/schema.prisma" : exists(root, "schema.prisma") ? "schema.prisma" : "prisma/schema.prisma";
}

export function configTemplate(root: string): string {
  const entries = detectEntryPoints(root);
  const lines = [
    'import { defineConfig } from "@averri/core";',
    "",
    "export default defineConfig({",
    '  sourceRoots: ["src"],',
    `  prismaSchema: "${detectPrismaSchema(root)}",`,
  ];
  if (entries.length > 0) lines.push(`  entryPoints: [${entries.map((e) => `"${e}"`).join(", ")}],`);
  lines.push(
    "  // Middleware names that authenticate a request (A2103 flags routes without one).",
    "  authMiddleware: [],",
    "  // Actor fixtures for generated tests; `anonymous` is mandatory. Add one per role.",
    "  actors: {",
    "    anonymous: { actor: null },",
    "  },",
    '  test: { databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" },',
    "});",
    "",
  );
  return lines.join("\n");
}

export const AVERRI_DTS = [
  'import type { PrismaClient, Prisma } from "@prisma/client";',
  "",
  'declare module "@averri/core" {',
  "  interface AverriTypes {",
  "    // Edit Actor to match what your auth middleware puts on the request.",
  "    Actor: { id: string; [key: string]: unknown };",
  "    PrismaClient: PrismaClient;",
  "    TransactionClient: Prisma.TransactionClient;",
  "    ModelName: Uncapitalize<Prisma.ModelName>;",
  "  }",
  "}",
  "",
].join("\n");

const DEV_DEPS: Record<string, string> = { vitest: "^2.0.0", "fast-check": "^4.0.0", "@averri/contracts": "^0.0.1" };
const DEPS: Record<string, string> = { "@averri/core": "^0.0.1" };

function ensurePackageJson(root: string, result: InitResult): void {
  const rel = "package.json";
  if (!exists(root, rel)) return;
  const raw = fs.readFileSync(path.join(root, rel), "utf8");
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const missing: string[] = [];
  const has = (n: string): boolean => Boolean(pkg.dependencies?.[n] ?? pkg.devDependencies?.[n]);
  for (const [n, v] of Object.entries(DEPS)) {
    if (has(n)) continue;
    (pkg.dependencies ??= {})[n] = v;
    missing.push(n);
  }
  for (const [n, v] of Object.entries(DEV_DEPS)) {
    if (has(n)) continue;
    (pkg.devDependencies ??= {})[n] = v;
    missing.push(n);
  }
  if (missing.length === 0) {
    result.unchanged.push(rel);
    return;
  }
  for (const key of ["dependencies", "devDependencies"] as const) {
    const o = pkg[key];
    if (o) pkg[key] = Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  write(root, rel, `${JSON.stringify(pkg, null, 2)}\n`);
  result.updated.push(rel);
  result.install = "npm install";
}

function ensureFile(root: string, rel: string, text: string, force: boolean, result: InitResult): void {
  if (exists(root, rel) && !force) {
    result.unchanged.push(rel);
    return;
  }
  const had = exists(root, rel);
  write(root, rel, text);
  (had ? result.updated : result.created).push(rel);
}

function ensureBlockFile(root: string, rel: string, prefix: string, result: InitResult): void {
  const abs = path.join(root, rel);
  const had = fs.existsSync(abs);
  const before = had ? fs.readFileSync(abs, "utf8") : prefix;
  const after = upsertAgentBlock(before);
  if (had && after === before) {
    result.unchanged.push(rel);
    return;
  }
  write(root, rel, after);
  (had ? result.updated : result.created).push(rel);
}

export function mcpSnippets(): McpSnippets {
  const server = mcpServerRegistration();
  return {
    claudeCode: `claude mcp add averri -- ${server.command} ${server.args.join(" ")}`,
    mcpJson: JSON.stringify({ mcpServers: { averri: server } }, null, 2),
    cursor: `.cursor/mcp.json:\n${JSON.stringify({ mcpServers: { averri: server } }, null, 2)}`,
    http: "npx averri mcp --http 3333",
  };
}

export function init(root: string, options: InitOptions = {}): InitResult {
  const result: InitResult = { root, created: [], updated: [], unchanged: [], install: null, mcp: mcpSnippets() };
  const force = options.force === true;
  const configFile = ["averri.config.ts", "averri.config.mts", "averri.config.js"].find((f) => exists(root, f));
  if (configFile) result.unchanged.push(configFile);
  else ensureFile(root, "averri.config.ts", configTemplate(root), force, result);
  if (configFile && force) ensureFile(root, configFile, configTemplate(root), true, result);
  ensureFile(root, "src/averri.d.ts", AVERRI_DTS, force, result);
  ensureBlockFile(root, "CLAUDE.md", "# CLAUDE.md\n\n", result);
  ensureBlockFile(root, "AGENTS.md", "# AGENTS.md\n\n", result);
  ensureBlockFile(root, ".cursor/rules/averri.mdc", CURSOR_FRONTMATTER, result);
  if (options.packageJson !== false) ensurePackageJson(root, result);
  result.unchanged = result.unchanged.filter((f) => !result.created.includes(f) && !result.updated.includes(f));
  return result;
}

export { AGENT_BLOCK_BEGIN as BLOCK_BEGIN, AGENT_BLOCK_END as BLOCK_END };
