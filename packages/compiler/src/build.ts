/**
 * The build pipeline (ARCHITECTURE §3): extract → lower declarations and config statically →
 * verify → rules → generated Test nodes (+ files when enabled) → dependsOn and health → canonical
 * graph → `.averri/graph.json` (+ snapshot, openapi.json, cards).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractFromContext, loadProject, type ExtractWarning } from "@averri/extract";
import {
  GRAPH_SCHEMA_VERSION,
  computeCounts,
  computeDependsOn,
  computeHealth,
  dedupeEdges,
  diffGraphs,
  partitionDanglingEdges,
  sortEdges,
  sortGraph,
  summarizeGraphDiff,
  validateGraph,
  type Diagnostic,
  type Graph,
  type Node,
  type NodeId,
  type StackSummary,
  type TestNode,
} from "@averri/ir";
import { deriveTestNodes, generateTests, parseGeneratedHeader, type GenerateOptions } from "@averri/testgen";
import { readCachedGraph, readLastGreenGraph, writeCachedGraph, writeFileAtomic, writeSnapshot, cachePath } from "./cache.js";
import { writeCards } from "./cards.js";
import { readConfig, type LoweredConfig } from "./config.js";
import { finalizeDiagnostics } from "./diagnostics.js";
import { gitInfo } from "./git.js";
import { lowerDeclarations, refreshAppliesTo } from "./lower/declarations.js";
import { toOpenApi } from "./openapi.js";
import { generatedFileReader, isStale, ruleA6001, runRules, type RuleContext } from "./rules/index.js";
import { createState, type BuildState } from "./state.js";
import { summarize } from "./summaries.js";
import { compareStrings, toPosix } from "./util.js";
import { finalizeProvenance, passZodMatch, runVerifiers } from "./verify/index.js";

export const AVERRI_VERSION = "0.0.1";

export interface BuildOptions {
  /** Repo-relative config module; default: the first `averri.config.*` found. `null` disables config. */
  configFile?: string | null;
  /** Write `.averri/graph.json`, the snapshot, openapi.json and cards. Default true. */
  writeCache?: boolean;
  /** Write/refresh `<generatedDir>/*.gen.test.ts` and delete files whose owner disappeared. Default false. */
  writeTests?: boolean;
  /** The previous build, for A1002 rename detection. Default: the cached graph.json. */
  previous?: Graph | null;
  /** Last-green snapshot for `since_last_green` and A3002 rename fixes. Default: the pinned snapshot. */
  lastGreen?: Graph | null;
  /** Clock (tests). */
  now?: () => Date;
  /** Read git HEAD/dirty. Default true. */
  git?: boolean;
  averriVersion?: string;
}

export interface GeneratedFilesReport {
  written: string[];
  unchanged: string[];
  deleted: string[];
}

export interface BuildResult {
  graph: Graph;
  config: LoweredConfig;
  warnings: ExtractWarning[];
  generated: GeneratedFilesReport;
  /** Wall-clock milliseconds per stage, for budgets. */
  timings: Record<string, number>;
}

/** Build the graph for a project root. Throws only on internal errors (diagnostics are data). */
export function build(rootDir: string, options: BuildOptions = {}): BuildResult {
  const timings: Record<string, number> = {};
  let t = Date.now();
  const lap = (name: string): void => {
    const now = Date.now();
    timings[name] = now - t;
    t = now;
  };
  const root = path.resolve(rootDir);
  const { config, diagnostics: configDiagnostics } = readConfig(root, options.configFile);
  const ctx = loadProject(root, {
    sourceRoots: config.sourceRoots,
    prismaSchema: config.prismaSchema,
    ...(config.entryPointsDeclared ? { entryPoints: config.entryPoints } : {}),
    publicMarker: config.publicMarker,
    generatedDir: config.test.generatedDir,
    configFile: config.file,
  });
  const extract = extractFromContext(ctx);
  lap("extract");
  const previous = options.previous === undefined ? readCachedGraph(root) : options.previous;
  const lastGreen = options.lastGreen === undefined ? readLastGreenGraph(root) : options.lastGreen;
  const state = createState(root, ctx, config, extract, previous, lastGreen);
  state.diagnostics.push(...configDiagnostics);

  lowerDeclarations(state);
  promoteHandlerModules(state);
  lap("lower");
  const verify = runVerifiers(state);
  refreshAppliesTo(state);
  lap("verify");
  const ruleCtx: RuleContext = { state, verify, previous, lastGreen, zodDrift: new Set() };
  state.diagnostics.push(...runRules(ruleCtx));
  passZodMatch(
    verify,
    state.facts.filter((f) => f.input?.isZod && f.input.fields !== null && !ruleCtx.zodDrift.has(f.nodeId)).map((f) => f.nodeId),
  );
  finalizeProvenance(state, verify);
  lap("rules");

  // Generated Test nodes (derived from the graph, D-13).
  const averriVersion = options.averriVersion ?? AVERRI_VERSION;
  const genOptions: GenerateOptions = {
    generatedDir: config.test.generatedDir,
    configFile: config.file ?? "averri.config.ts",
    averriVersion,
    actors: config.actors,
  };
  const entry = config.entryPoints[0] ?? extract.stack.entryPoints[0];
  if (entry) genOptions.entryPoint = entry;
  const usesZod = extract.stack.validator === "zod" || state.facts.some((f) => f.input?.isZod === true);
  const stack = stackSummary(root, config, { ...extract.stack, validator: usesZod ? "zod" : null });
  const builtAt = (options.now ?? (() => new Date()))().toISOString();
  const git = options.git === false ? { commit: null, dirty: false } : gitInfo(root);
  const draft = assemble(state, { stack, builtAt, git, contentHash: extract.contentHash, averriVersion, root });
  const derived = deriveTestNodes(draft, genOptions);
  for (const n of derived.nodes) state.nodes.set(n.id, n);
  state.edges.push(...derived.edges);
  const generated: GeneratedFilesReport = { written: [], unchanged: [], deleted: [] };
  if (options.writeTests) writeGeneratedTests(root, assemble(state, { stack, builtAt, git, contentHash: extract.contentHash, averriVersion, root }), genOptions, generated);
  state.diagnostics.push(...ruleA6001(ruleCtx));
  lap("testgen");

  summarize(state.nodes, state.edges);
  let graph = assemble(state, { stack, builtAt, git, contentHash: extract.contentHash, averriVersion, root });
  graph.edges = sortEdges(dedupeEdges([...graph.edges, ...computeDependsOn(graph)]));
  // since_last_green, ids, budgets
  let sinceLastGreen: ((ids: NodeId[]) => string | null) | null = null;
  if (lastGreen) {
    const diff = diffGraphs(lastGreen, graph);
    sinceLastGreen = (ids) => summarizeGraphDiff(diff, ids);
  }
  graph.diagnostics = finalizeDiagnostics(state.diagnostics, { nodes: graph.nodes, sinceLastGreen });
  const read = generatedFileReader(root);
  graph.meta.health = computeHealth(graph, {
    authMiddleware: config.authMiddleware,
    staleGeneratedTests: (tn: TestNode) => isStale(read, tn),
  });
  graph = sortGraph(graph);
  graph = validateGraph(JSON.parse(JSON.stringify(graph)));
  lap("finalize");

  if (options.writeCache !== false) {
    writeCachedGraph(root, graph);
    writeSnapshot(root, graph);
    writeFileAtomic(cachePath(root, "openapi.json"), `${JSON.stringify(toOpenApi(graph), null, 2)}\n`);
    writeCards(root, graph);
    lap("write");
  }
  return { graph, config, warnings: extract.warnings, generated, timings };
}

/** Summaries are capped at 200 characters by the IR schema (SPEC-IR); re-apply the cap after any rewrite. */
function clampSummary(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}

/**
 * A Module that implements an Action or Query (the target of an `implementedBy` edge, i.e. the
 * declaration's `handler:` file) is a handler module even when no route registration names it
 * directly (D-41c). Without the promotion SPEC-IR §5's propagation rule never fires for service
 * modules and an edit there would select no test.
 */
export function promoteHandlerModules(state: Pick<BuildState, "nodes" | "edges">): void {
  for (const edge of state.edges) {
    if (edge.kind !== "implementedBy") continue;
    const module = state.nodes.get(edge.to);
    if (module?.kind !== "Module" || module.role !== "other") continue;
    state.nodes.set(module.id, {
      ...module,
      role: "handler",
      summary: clampSummary(module.summary.replace(/^other module /, "handler module ")),
      provenance:
        module.provenance.origin === "extracted"
          ? { ...module.provenance, evidence: module.provenance.evidence.map((ev) => ({ ...ev, note: ev.note.replace(/ (other)$/, " (handler)") })) }
          : module.provenance,
    });
  }
}

interface AssembleMeta {
  stack: StackSummary;
  builtAt: string;
  git: { commit: string | null; dirty: boolean };
  contentHash: string;
  averriVersion: string;
  root: string;
}

/** A schema-shaped graph from the current state (dangling edges dropped, counts computed). */
function assemble(state: BuildState, m: AssembleMeta): Graph {
  const nodes: Record<NodeId, Node> = {};
  for (const id of [...state.nodes.keys()].sort(compareStrings)) nodes[id] = state.nodes.get(id) as Node;
  const { valid } = partitionDanglingEdges({ nodes, edges: dedupeEdges(state.edges) });
  const graph: Graph = {
    meta: {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      averriVersion: m.averriVersion,
      builtAt: m.builtAt,
      commit: m.git.commit,
      dirty: m.git.dirty,
      contentHash: m.contentHash,
      root: toPosix(m.root),
      stack: m.stack,
      counts: computeCounts(nodes),
      health: computeHealth({ nodes, edges: valid, diagnostics: [] }),
    },
    nodes,
    edges: sortEdges(valid),
    diagnostics: [] as Diagnostic[],
  };
  return graph;
}

function detectPackageManager(root: string): StackSummary["packageManager"] {
  let cur = root;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(cur, "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(cur, "yarn.lock"))) return "yarn";
    if (fs.existsSync(path.join(cur, "bun.lockb")) || fs.existsSync(path.join(cur, "bun.lock"))) return "bun";
    if (fs.existsSync(path.join(cur, "package-lock.json"))) return "npm";
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return "unknown";
}

function stackSummary(root: string, config: LoweredConfig, s: { prismaSchema: string | null; routers: StackSummary["routers"]; validator: "zod" | null; testRunner: "vitest" | null; entryPoints: string[] }): StackSummary {
  const pm = detectPackageManager(root);
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    scripts = {};
  }
  const run = (name: string): string => (pm === "yarn" ? `yarn ${name}` : pm === "pnpm" ? `pnpm ${name}` : pm === "bun" ? `bun run ${name}` : `npm run ${name}`);
  const typecheckScript = ["typecheck", "type-check", "tsc", "check:types"].find((k) => scripts[k]);
  const conventions: string[] = [];
  if (config.authMiddleware.length) conventions.push(`auth middleware: ${config.authMiddleware.join(", ")}`);
  if (config.publicMarker) conventions.push(`public routes are marked with ${config.publicMarker}()`);
  if (config.eventNamePrefix !== null) conventions.push(`events are published as "${config.eventNamePrefix}<Event>"`);
  conventions.push(`actor fixtures: ${config.actors.join(", ")}`);
  conventions.push(`generated tests live in ${config.test.generatedDir} (never edit them)`);
  return {
    orm: "prisma",
    prismaSchema: s.prismaSchema,
    routers: s.routers,
    validator: s.validator,
    testRunner: s.testRunner,
    packageManager: pm,
    entryPoints: s.entryPoints,
    commands: {
      build: scripts.build ? run("build") : null,
      test: scripts.test ? run("test") : s.testRunner ? "npx vitest run" : null,
      typecheck: typecheckScript ? run(typecheckScript) : "npx tsc --noEmit",
    },
    conventions: conventions.slice(0, 5),
  };
}

/** True when the file on disk is the generated content (CRLF checkouts compare equal). */
export function sameGeneratedContent(onDisk: string, content: string): boolean {
  return onDisk.replace(/\r\n/g, "\n") === content;
}

/**
 * Write generated files whose content differs (the header hash covers the graph inputs, not the
 * generator options such as the entry/config import paths or the generator version, D-40);
 * delete generated files whose owner disappeared.
 */
export function writeGeneratedTests(root: string, graph: Graph, options: GenerateOptions, report: GeneratedFilesReport): void {
  const files = generateTests(graph, options);
  const keep = new Set(files.map((f) => f.path));
  for (const f of files) {
    const abs = path.join(root, f.path);
    const onDisk = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (onDisk !== null && sameGeneratedContent(onDisk, f.content)) {
      report.unchanged.push(f.path);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    report.written.push(f.path);
  }
  const dir = path.join(root, options.generatedDir ?? "tests/averri");
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".gen.test.ts")) continue;
      const rel = toPosix(path.join(options.generatedDir ?? "tests/averri", name));
      if (keep.has(rel)) continue;
      const content = fs.readFileSync(path.join(dir, name), "utf8");
      if (!parseGeneratedHeader(content)) continue; // never delete a file Averri did not generate
      fs.unlinkSync(path.join(dir, name));
      report.deleted.push(rel);
    }
  }
}
