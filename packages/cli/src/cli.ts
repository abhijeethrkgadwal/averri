/**
 * The `averri` program (commander 14). `run(argv, io)` is the single entry point used by `bin.ts` and
 * by tests; it returns the process exit code: 0 ok, 1 diagnostics errors (or a failed tool call),
 * 2 usage. `--json` prints exactly `JSON.stringify(<tool response>)` for the tool commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "@averri/compiler";
import type { Diagnostic } from "@averri/ir";
import { Command, CommanderError, Option } from "commander";
import { fileURLToPath } from "node:url";
import { docs } from "./commands/docs.js";
import { fmt } from "./commands/fmt.js";
import { init } from "./commands/init.js";
import { report } from "./commands/report.js";
import { testgen } from "./commands/testgen.js";
import {
  colors,
  renderCheck,
  renderDiagnostics,
  renderExplain,
  renderFind,
  renderImpact,
  renderInspect,
  renderOverview,
  renderProposals,
  renderToolError,
  type Colors,
} from "./human.js";
import { EXIT_DIAGNOSTICS, EXIT_OK, EXIT_USAGE, UsageError, processIo, type Io } from "./io.js";
import { runTool, exitCodeOf, serialize, NODE_KINDS, type ToolContext, type ToolName, type ToolResponse } from "./tools.js";

/** This package's version (src/ and dist/ are both one level below package.json). */
const PKG_VERSION = (JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }).version;

export interface RunOptions {
  /** Overrides passed to `check` (tests inject fake tsc/vitest runners). */
  check?: ToolContext["check"];
}

const hasErrors = (ds: readonly Diagnostic[]): boolean => ds.some((d) => d.severity === "error");

type MaybeColors = Colors;

export function createProgram(io: Io, state: { exit: number }, options: RunOptions = {}): Command {
  const program = new Command();
  const c = colors(io.color);
  const root = (): string => path.resolve(io.cwd, (program.opts() as { root?: string }).root ?? ".");
  const out = (s: string): void => io.stdout(s);
  const json = (v: unknown): void => out(`${JSON.stringify(v)}\n`);

  program
    .name("averri")
    .description("Contracts and a semantic graph for agent-written TypeScript backends")
    .version(PKG_VERSION)
    .option("--root <dir>", "project root (default: current directory)")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) })
    .showHelpAfterError(false);

  /** Run a tool command: JSON mirror or human rendering, exit code per `exitCodeOf`. */
  const tool = async (name: ToolName, input: unknown, asJson: boolean | undefined, human: (data: never, c: MaybeColors) => string): Promise<void> => {
    const res: ToolResponse<unknown> = await runTool(name, input, { root: root(), ...(options.check ? { check: options.check } : {}) });
    state.exit = exitCodeOf(res);
    if (name === "check" && res.ok && !(res.data as { green: boolean }).green) state.exit = EXIT_DIAGNOSTICS;
    if (asJson) return out(`${serialize(res)}
`);
    if (!res.ok) {
      io.stderr(renderToolError(c, res));
      return;
    }
    out(human(res.data as never, c));
    if (res.truncated) out(c.dim(`(truncated${res.more ? `; more: ${res.more.join(", ")}` : ""})\n`));
  };

  program
    .command("init")
    .description("write averri.config.ts, the agent block (CLAUDE.md, AGENTS.md, .cursor/rules) and print MCP config snippets")
    .option("--no-package-json", "do not add dependencies to package.json")
    .option("--force", "overwrite averri.config.ts and src/averri.d.ts")
    .option("--json", "machine-readable result")
    .action((o: { packageJson: boolean; force?: boolean; json?: boolean }) => {
      const r = init(root(), { packageJson: o.packageJson, force: o.force === true });
      if (o.json) return json(r);
      for (const f of r.created) out(`${c.green("created")}   ${f}\n`);
      for (const f of r.updated) out(`${c.yellow("updated")}   ${f}\n`);
      for (const f of r.unchanged) out(`${c.dim("unchanged")} ${f}\n`);
      if (r.install) out(`\nRun ${c.bold(r.install)} to install the added dependencies.\n`);
      out(`\n${c.bold("Register the MCP server")}\n  Claude Code: ${r.mcp.claudeCode}\n  .mcp.json:\n${r.mcp.mcpJson.replace(/^/gm, "    ")}\n  ${r.mcp.cursor.replace(/\n/g, "\n    ")}\n  HTTP: ${r.mcp.http}\n`);
    });

  program
    .command("build")
    .description("build the graph, refresh .averri/ and the generated tests")
    .option("--json", "machine-readable result")
    .action((o: { json?: boolean }) => {
      const r = build(root(), { writeTests: true });
      const g = r.graph;
      state.exit = hasErrors(g.diagnostics) ? EXIT_DIAGNOSTICS : EXIT_OK;
      if (o.json) return json({ ok: state.exit === EXIT_OK, counts: g.meta.counts, health: g.meta.health, generated: r.generated, diagnostics: g.diagnostics, contentHash: g.meta.contentHash });
      out(`${c.bold("built")} ${Object.values(g.nodes).length} nodes, ${g.edges.length} edges (${g.meta.contentHash.slice(0, 12)})\n`);
      out(`generated tests: ${r.generated.written.length} written, ${r.generated.unchanged.length} unchanged, ${r.generated.deleted.length} deleted\n\n`);
      out(renderDiagnostics(c, g.diagnostics));
    });

  program
    .command("check")
    .description("build, typecheck, run the affected tests, report diagnostics")
    .addOption(new Option("--scope <scope>", "which tests to run").choices(["affected", "all"]))
    .option("--base <ref>", "git ref to compute the affected set against")
    .option("--acknowledge-weakening", "accept removed or weakened contracts")
    .option("--json", "the same JSON as the MCP check tool")
    .action(async (o: { scope?: "affected" | "all"; base?: string; acknowledgeWeakening?: boolean; json?: boolean }) => {
      const input = { ...(o.scope ? { scope: o.scope } : {}), ...(o.base ? { diffBase: o.base } : {}), ...(o.acknowledgeWeakening ? { acknowledgeWeakening: true } : {}) };
      await tool("check", input, o.json, (d, col) => renderCheck(col, d));
    });

  program
    .command("docs")
    .description("write SPEC.md cards per module directory and the OpenAPI document")
    .option("--openapi <file>", "OpenAPI output path (default .averri/openapi.json)")
    .option("--no-spec", "skip the SPEC.md files")
    .option("--json", "machine-readable result")
    .action(async (o: { openapi?: string; spec: boolean; json?: boolean }) => {
      const r = await docs(root(), { ...(o.openapi ? { openapi: o.openapi } : {}), noSpec: !o.spec });
      if (o.json) return json({ ok: true, ...r });
      for (const f of r.specFiles) out(`${c.green("wrote")} ${f}\n`);
      out(`${c.green("wrote")} ${r.openapi}  (${r.cards} cards)\n`);
    });

  program
    .command("report")
    .description("impact and diagnostics of the working tree against a git ref")
    .requiredOption("--base <ref>", "git ref to compare against")
    .option("--json", "machine-readable result")
    .action(async (o: { base: string; json?: boolean }) => {
      const r = await report(root(), o.base);
      if (!r.ok) {
        state.exit = EXIT_USAGE;
        if (o.json) return json(r);
        io.stderr(`${c.red("bad-input")}: ${r.message}\n`);
        return;
      }
      state.exit = hasErrors(r.diagnostics.introduced) ? EXIT_DIAGNOSTICS : EXIT_OK;
      if (o.json) return json(r);
      out(`${c.bold("Report")} ${o.base}..${r.head.commit?.slice(0, 8) ?? "working tree"}${r.head.dirty ? " (dirty)" : ""}: ${r.summary || "no graph changes"}\n\n`);
      out(renderImpact(c, r.impact));
      out(`\n${c.bold("Diagnostics")}: ${r.diagnostics.counts.errors} errors, ${r.diagnostics.counts.warnings} warnings; ${r.diagnostics.introduced.length} introduced, ${r.diagnostics.resolved.length} resolved\n`);
      if (r.diagnostics.introduced.length > 0) out(renderDiagnostics(c, r.diagnostics.introduced));
    });

  program
    .command("fmt")
    .description("put declaration option keys into canonical order")
    .argument("[files...]", "repo-relative files (default: all files under src that import @averri/core)")
    .option("--check", "report files that would change and exit 1; write nothing")
    .option("--json", "machine-readable result")
    .action((files: string[], o: { check?: boolean; json?: boolean }) => {
      const r = fmt(root(), { check: o.check === true, ...(files.length > 0 ? { files } : {}) });
      if (o.check && r.changed.length > 0) state.exit = EXIT_DIAGNOSTICS;
      if (o.json) return json({ ok: state.exit === EXIT_OK, ...r });
      for (const ch of r.changes) out(`${o.check ? c.yellow("would reorder") : c.green("reordered")} ${ch.file}:${ch.line} ${ch.construct}(): ${ch.after.join(", ")}\n`);
      for (const s of r.skipped) out(`${c.dim("skipped")} ${s.file}:${s.line} ${s.construct}(): ${s.reason}\n`);
      out(`${r.checked} file(s) checked, ${r.changed.length} ${o.check ? "need formatting" : "formatted"}\n`);
    });

  program
    .command("testgen")
    .description("regenerate tests/averri/*.gen.test.ts")
    .option("--only <ids...>", "restrict to these Test or owner ids (nothing is deleted)")
    .option("--json", "machine-readable result")
    .action(async (o: { only?: string[]; json?: boolean }) => {
      const r = await testgen(root(), o.only ?? []);
      if (o.json) return json({ ok: true, ...r });
      for (const f of r.written) out(`${c.green("wrote")}   ${f}\n`);
      for (const f of r.deleted) out(`${c.yellow("deleted")} ${f}\n`);
      out(`${r.written.length} written, ${r.unchanged.length} unchanged, ${r.deleted.length} deleted\n`);
    });

  program
    .command("suggest")
    .description("draft observe-mode declarations for undeclared routes (a diff, never applied)")
    .argument("[id]", "an Exposure, Action or Query id")
    .option("--json", "the same JSON as the MCP suggest tool")
    .action(async (id: string | undefined, o: { json?: boolean }) => {
      await tool("suggest", id ? { id } : {}, o.json, (d: { proposals: Parameters<typeof renderProposals>[1]; message?: string }, col) => renderProposals(col, d.proposals, d.message));
    });

  program
    .command("mcp")
    .description("start the MCP server (stdio, or streamable HTTP with --http)")
    .option("--http <port>", "serve streamable HTTP on this port instead of stdio")
    .action(async (o: { http?: string }) => {
      let port: number | undefined;
      if (o.http !== undefined) {
        port = Number(o.http);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--http expects a port number, got ${o.http}`);
      }
      state.exit = await startMcp(root(), port, io);
    });

  program
    .command("overview")
    .description("session orientation: stack, counts, health")
    .option("--json", "the same JSON as the MCP overview tool")
    .action((o: { json?: boolean }) => tool("overview", {}, o.json, (d, col) => renderOverview(col, d)));

  program
    .command("find")
    .description("locate nodes by name or meaning")
    .argument("<query>", "search text")
    .addOption(new Option("--kind <kind>", "restrict to a node kind").choices([...NODE_KINDS]))
    .option("--limit <n>", "maximum hits", (v) => Number.parseInt(v, 10))
    .option("--json", "the same JSON as the MCP find tool")
    .action((query: string, o: { kind?: string; limit?: number; json?: boolean }) =>
      tool("find", { query, ...(o.kind ? { kind: o.kind } : {}), ...(o.limit !== undefined ? { limit: o.limit } : {}) }, o.json, (d: { hits: Parameters<typeof renderFind>[1] }, col) => renderFind(col, d.hits)),
    );

  program
    .command("inspect")
    .description("everything about one node")
    .argument("<id>", "NodeId or bare qualifier")
    .addOption(new Option("--include <what...>", "extra sections").choices(["source", "history", "tests"]))
    .option("--json", "the same JSON as the MCP inspect tool")
    .action((id: string, o: { include?: string[]; json?: boolean }) => tool("inspect", { id, ...(o.include ? { include: o.include } : {}) }, o.json, (d, col) => renderInspect(col, d)));

  program
    .command("impact")
    .description("what a node or a change affects")
    .argument("[id]", "NodeId or bare qualifier")
    .option("--diff <file>", "unified diff file, or - for stdin")
    .option("--base <ref>", "git ref to compare the working tree against")
    .option("--json", "the same JSON as the MCP impact tool")
    .action(async (id: string | undefined, o: { diff?: string; base?: string; json?: boolean }) => {
      let diff: string | undefined;
      if (o.diff !== undefined) {
        try {
          diff = o.diff === "-" ? await io.stdin() : fs.readFileSync(path.resolve(io.cwd, o.diff), "utf8");
        } catch (e) {
          throw new UsageError(`cannot read diff ${o.diff}: ${(e as Error).message}`);
        }
      }
      await tool("impact", { ...(id ? { id } : {}), ...(diff !== undefined ? { diff } : {}), ...(o.base ? { base: o.base } : {}) }, o.json, (d, col) => renderImpact(col, d));
    });

  program
    .command("explain")
    .description("why a test or diagnostic failed: chain, input, change since last green")
    .argument("[id]", "a Test id, a diagnostic id (D-0001) or a trace id")
    .option("--test <id>", "Test id")
    .option("--diag <id>", "diagnostic id from the last build")
    .option("--trace <id>", "trace id from .averri/traces")
    .option("--code <code>", "diagnostic code (with --node)")
    .option("--node <id>", "node id (with --code)")
    .addOption(new Option("--detail <level>", "summary or full").choices(["summary", "full"]))
    .option("--json", "the same JSON as the MCP explain tool")
    .action((id: string | undefined, o: { test?: string; diag?: string; trace?: string; code?: string; node?: string; detail?: string; json?: boolean }) => {
      const input: Record<string, unknown> = {};
      if (o.test) input.testId = o.test;
      if (o.diag) input.diagId = o.diag;
      if (o.trace) input.traceId = o.trace;
      if (o.code || o.node) {
        if (!o.code || !o.node) throw new UsageError("--code and --node must be given together");
        input.diag = { code: o.code, node: o.node };
      }
      if (id) {
        if (id.startsWith("Test:")) input.testId = id;
        else if (/^D-\d+$/.test(id)) input.diagId = id;
        else input.traceId = id;
      }
      if (o.detail) input.detail = o.detail;
      return tool("explain", input, o.json, (d, col) => renderExplain(col, d));
    });

  return program;
}

/**
 * Start the MCP server. stdout belongs to the protocol in stdio mode, so all messages go to stderr.
 * Resolves once the transport is connected; the open stdin/socket keeps the process alive.
 */
async function startMcp(rootDir: string, port: number | undefined, io: Io): Promise<number> {
  // Loaded lazily so the other commands never pay for the MCP SDK.
  const mcp = await import("@averri/mcp");
  if (port === undefined) {
    await mcp.runStdio({ root: rootDir });
    return EXIT_OK;
  }
  const handle = await mcp.runHttp({ root: rootDir }, port);
  io.stderr(`averri mcp: listening on http://127.0.0.1:${handle.port}/mcp\n`);
  return EXIT_OK;
}

/** Run the CLI. `argv` excludes `node` and the script. Returns the exit code. */
export async function run(argv: readonly string[], io: Io = processIo(), options: RunOptions = {}): Promise<number> {
  const state = { exit: EXIT_OK };
  const program = createProgram(io, state, options);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      // help and version are successful; everything else is a usage error (message already written).
      return e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help" ? EXIT_OK : EXIT_USAGE;
    }
    if (e instanceof UsageError) {
      io.stderr(`averri: ${e.message}\n`);
      return EXIT_USAGE;
    }
    io.stderr(`averri: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_DIAGNOSTICS;
  }
  return state.exit;
}
