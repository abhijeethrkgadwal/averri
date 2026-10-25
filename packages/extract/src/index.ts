/**
 * @averri/extract — extractors producing `extracted` nodes and edges for the Averri Semantic IR.
 *
 * `extractProject(rootDir, options)` runs, in order: Prisma schema facts, Zod schema references,
 * Hono/Express route extraction (Exposures, middleware attribution, mount-tree composition),
 * hand-written Vitest tests, Module nodes and the repository content hash. Everything is static:
 * no user module is ever evaluated (D-2).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dedupeEdges, sortEdges, type Edge, type Evidence, type Node, type NodeId } from "@averri/ir";
import { extractModules, type RoleHints } from "./modules.js";
import { extractPrismaSchema } from "./prisma.js";
import { collectInputFiles, contentHashOf, loadProject, type ProjectContext } from "./project.js";
import { extractRoutes } from "./routes.js";
import { extractTests } from "./tests.js";
import type { ExtractOptions, ExtractResult, ExtractWarning, PrismaFacts, ZodSchemaFact } from "./types.js";
import { compareStrings } from "./util.js";
import { extractZodSchemas, type ZodIndex } from "./zod.js";

export * from "./types.js";
export { extractPrismaSchema, renderFieldType, PRISMA_CONFIDENCE, type PrismaExtraction } from "./prisma.js";
export { extractRoutes, creationOf, ROUTE_CONFIDENCE, type RouteExtraction } from "./routes.js";
export { extractZodSchemas, zodSchemaRefOf, isZodChain, ZOD_CONFIDENCE, type ZodIndex } from "./zod.js";
export { extractTests, TEST_CONFIDENCE, type TestExtraction } from "./tests.js";
export { extractModules, roleOf, exportNames, isDeclarationModule, type RoleHints } from "./modules.js";
export { loadProject, resolveOptions, collectInputFiles, contentHashOf, type ProjectContext, type ResolvedOptions } from "./project.js";
export {
  normalizeRoutePath,
  composePath,
  routePathsMatch,
  usePatternMatches,
  middlewareCallee,
  middlewareMatches,
  toHttpMethod,
  hasWildcard,
} from "./paths.js";
export { staticString, staticStringArray, resolveDeclaration, symbolRefOf, unwrap, importSourceOf } from "./resolve.js";
export { sha256, relPath, toPosix, countLines, uncapitalize } from "./util.js";

/**
 * Run every extractor over a project root. Never throws on malformed inputs: problems become
 * `warnings` and the affected facts are omitted or marked `dynamic`/incomplete.
 */
export function extractProject(rootDir: string, options: ExtractOptions = {}): ExtractResult {
  const ctx = loadProject(rootDir, options);
  return extractFromContext(ctx);
}

/** Same as {@link extractProject} on an already loaded {@link ProjectContext} (lets the compiler reuse the ts-morph project). */
export function extractFromContext(ctx: ProjectContext): ExtractResult {
  const warnings: ExtractWarning[] = [...ctx.warnings];
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const inc = ctx.options.include;

  // 1. Prisma
  let prisma: PrismaFacts | null = null;
  if (inc.prisma) {
    if (ctx.prismaSchemaFile) {
      const text = fs.readFileSync(path.join(ctx.rootDir, ctx.prismaSchemaFile), "utf8");
      const p = extractPrismaSchema(text, ctx.prismaSchemaFile);
      nodes.push(...p.nodes, p.module);
      edges.push(...p.edges);
      warnings.push(...p.warnings);
      prisma = p.facts;
    } else if (ctx.options.prismaSchema) {
      warnings.push({ code: "prisma-schema-missing", message: `Prisma schema ${ctx.options.prismaSchema} not found`, file: ctx.options.prismaSchema });
    }
  }

  // 2. Zod
  let zod: ZodIndex = { facts: [], warnings: [], byDeclaration: new Map() };
  if (inc.zod) {
    zod = extractZodSchemas(ctx);
    warnings.push(...zod.warnings);
  }
  const zodSchemas: ZodSchemaFact[] = zod.facts;

  // 3. Routes
  const routeFiles = new Set<string>();
  const handlerFiles = new Set<string>();
  let routers: ExtractResult["stack"]["routers"] = [];
  let entryPoints: string[] = ctx.options.entryPoints ?? [];
  if (inc.routes) {
    const r = extractRoutes(ctx, zod, [...ctx.sourceFiles, ...(ctx.options.entryPoints ?? [])].filter((f, i, a) => a.indexOf(f) === i).sort(compareStrings));
    nodes.push(...r.nodes);
    edges.push(...r.edges);
    warnings.push(...r.warnings);
    r.routeFiles.forEach((f) => routeFiles.add(f));
    r.handlerFiles.forEach((f) => handlerFiles.add(f));
    routers = r.routers;
    entryPoints = ctx.options.entryPoints ?? r.entryPoints;
  }

  // 4. Tests
  const testFiles = new Set<string>(ctx.testFiles);
  let testRunner: "vitest" | null = null;
  if (inc.tests) {
    const t = extractTests(ctx);
    nodes.push(...t.nodes);
    edges.push(...t.edges);
    warnings.push(...t.warnings);
    if (t.nodes.length > 0) testRunner = "vitest";
  }

  // 5. Modules
  if (inc.modules) {
    const hints: RoleHints = { routeFiles, handlerFiles, testFiles, configFile: ctx.options.configFile };
    nodes.push(...extractModules(ctx, hints));
  }

  // 6. Content hash
  const inputFiles = collectInputFiles(ctx);
  const contentHash = contentHashOf(inputFiles);

  nodes.sort((a, b) => compareStrings(a.id, b.id));
  const evidence: Record<NodeId, Evidence[]> = {};
  for (const n of nodes) if (n.provenance.origin === "extracted") evidence[n.id] = n.provenance.evidence;

  return {
    nodes,
    edges: sortEdges(dedupeEdges(edges)),
    evidence,
    warnings,
    contentHash,
    inputFiles,
    zodSchemas,
    prisma,
    stack: {
      prismaSchema: ctx.prismaSchemaFile,
      routers,
      validator: zodSchemas.length > 0 ? "zod" : null,
      testRunner,
      entryPoints,
      configFile: ctx.options.configFile,
    },
  };
}
