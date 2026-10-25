/**
 * Public entry points: `generateTests(graph, options)` -> files, `planTests(graph, options)` -> suites.
 * Deterministic: owners are visited in id order per kind, files are sorted by path, and nothing in
 * the output depends on time, randomness or the environment.
 */

import { nodesOfKind, type Graph, type Node } from "@averri/ir";
import { buildOwnerFile, type OwnerFile } from "./file.js";
import { SchemaFacts } from "./schema.js";
import type { Ctx } from "./model.js";
import type { GenerateOptions, GeneratedFile, PlannedSuite, ResolvedOptions } from "./types.js";

export const DEFAULT_GENERATED_DIR = "tests/averri";
export const DEFAULT_CONFIG_FILE = "averri.config.ts";
export const DEFAULT_NUM_RUNS = 10;

export function resolveOptions(graph: Graph, options: GenerateOptions = {}): ResolvedOptions {
  const actors = ["anonymous", ...(options.actors ?? []).filter((a) => a !== "anonymous")];
  return {
    generatedDir: (options.generatedDir ?? DEFAULT_GENERATED_DIR).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""),
    configFile: (options.configFile ?? DEFAULT_CONFIG_FILE).replace(/\\/g, "/").replace(/^\.\//, ""),
    entryPoint: (options.entryPoint ?? graph.meta.stack.entryPoints[0] ?? null)?.replace(/\\/g, "/").replace(/^\.\//, "") ?? null,
    averriVersion: options.averriVersion ?? graph.meta.averriVersion,
    actors,
    numRuns: options.numRuns ?? DEFAULT_NUM_RUNS,
    only: options.only && options.only.length > 0 ? new Set(options.only) : null,
  };
}

/** Owners in generation order: Actions, Queries, Entities, Events, Integrations (each in id order). */
export function ownersOf(graph: Graph): Node[] {
  return [
    ...nodesOfKind(graph, "Action"),
    ...nodesOfKind(graph, "Query"),
    ...nodesOfKind(graph, "Entity"),
    ...nodesOfKind(graph, "Event"),
    ...nodesOfKind(graph, "Integration"),
  ];
}

export function buildOwnerFiles(graph: Graph, options: GenerateOptions = {}): OwnerFile[] {
  const ctx: Ctx = { graph, facts: new SchemaFacts(graph), options: resolveOptions(graph, options) };
  const files: OwnerFile[] = [];
  for (const owner of ownersOf(graph)) {
    const file = buildOwnerFile(ctx, owner);
    if (!file) continue;
    if (ctx.options.only && !ctx.options.only.has(owner.id) && !file.suites.some((s) => ctx.options.only?.has(s.id))) continue;
    files.push(file);
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Generate `tests/averri/*.gen.test.ts` contents for every owner that yields at least one suite. */
export function generateTests(graph: Graph, options: GenerateOptions = {}): GeneratedFile[] {
  return buildOwnerFiles(graph, options).map((f) => ({ path: f.path, content: f.content, hash: f.hash, owner: f.owner, tests: f.suites.map((s) => s.id) }));
}

/** The suites `generateTests` would produce (one per future Test node). Rendering is cheap, so this renders and keeps only the plan. */
export function planTests(graph: Graph, options: GenerateOptions = {}): PlannedSuite[] {
  return buildOwnerFiles(graph, options).flatMap((f) => f.suites);
}
