/**
 * `loadOrBuild` (SPEC-MCP §4): serve `.averri/graph.json` only when it validates and its contentHash
 * equals the hash of the current input files; otherwise rebuild under `.averri/build.lock`. Never
 * serves a stale graph: when the build throws, the error propagates.
 */

import type { Graph } from "@averri/ir";
import { build, AVERRI_VERSION, type BuildOptions, type BuildResult } from "./build.js";
import { acquireBuildLock, readCachedGraph } from "./cache.js";
import { readConfig } from "./config.js";
import { gitInfo } from "./git.js";
import { computeContentHash } from "./inputs.js";

export interface LoadOptions extends BuildOptions {
  /** Max wait for a concurrent build's lock. Default 120 s. */
  lockTimeoutMs?: number;
}

export interface LoadResult {
  graph: Graph;
  /** True when this call rebuilt the graph. */
  rebuilt: boolean;
  /** The build result when rebuilt. */
  build: BuildResult | null;
}

/** True when a cached graph is current for `root`. */
export function isFresh(root: string, graph: Graph | null, options: Pick<BuildOptions, "configFile" | "averriVersion"> = {}): graph is Graph {
  if (!graph) return false;
  if (graph.meta.averriVersion !== (options.averriVersion ?? AVERRI_VERSION)) return false;
  const { config } = readConfig(root, options.configFile);
  return graph.meta.contentHash === computeContentHash(root, config);
}

function refreshGit(root: string, graph: Graph, options: LoadOptions): Graph {
  if (options.git === false) return graph;
  const g = gitInfo(root);
  if (g.commit === graph.meta.commit && g.dirty === graph.meta.dirty) return graph;
  return { ...graph, meta: { ...graph.meta, commit: g.commit, dirty: g.dirty } };
}

export async function loadOrBuildWithInfo(root: string, options: LoadOptions = {}): Promise<LoadResult> {
  const cached = readCachedGraph(root);
  if (isFresh(root, cached, options)) return { graph: refreshGit(root, cached, options), rebuilt: false, build: null };
  const lock = await acquireBuildLock(root, options.lockTimeoutMs);
  try {
    const again = readCachedGraph(root);
    if (isFresh(root, again, options)) return { graph: refreshGit(root, again, options), rebuilt: false, build: null };
    const result = build(root, { ...options, previous: options.previous === undefined ? again ?? cached : options.previous, writeCache: true });
    return { graph: result.graph, rebuilt: true, build: result };
  } finally {
    lock.release();
  }
}

/** The current graph for `root` (cached when fresh, rebuilt otherwise). */
export async function loadOrBuild(root: string, options: LoadOptions = {}): Promise<Graph> {
  return (await loadOrBuildWithInfo(root, options)).graph;
}
