/**
 * Bounded node history (SPEC-IR §7, D-31): walk at most 20 commits from `git log -- <node.src.file>`,
 * build (or reuse snapshots of) each revision, diff consecutive graphs, keep ops touching the node;
 * stop after 10 ops or 10 s and report `truncated`.
 */

import { opsTouching, diffGraphs, type Graph, type HistoryEntry, type NodeId } from "@averri/ir";
import { gitLogFile } from "./git.js";
import { buildAtRef } from "./revisions.js";

export interface HistoryOptions {
  maxCommits?: number;
  maxOps?: number;
  timeMs?: number;
  /** Injected for tests: graph at a commit. */
  graphAt?: (commit: string) => Graph | null;
}

export function nodeHistory(root: string, graph: Graph, id: NodeId, options: HistoryOptions = {}): { entries: HistoryEntry[]; truncated: boolean } {
  const node = graph.nodes[id];
  const file = node?.src?.file;
  if (!file) return { entries: [], truncated: false };
  const maxOps = options.maxOps ?? 10;
  const deadline = Date.now() + (options.timeMs ?? 10_000);
  const commits = gitLogFile(root, file, options.maxCommits ?? 20);
  const graphAt = options.graphAt ?? ((c: string) => buildAtRef(root, c));
  const entries: HistoryEntry[] = [];
  let newer: Graph | null = graph;
  let newerCommit: { commit: string; at: string; author: string } | null = null;
  let truncated = false;
  for (const c of commits) {
    if (Date.now() > deadline || entries.length >= maxOps) {
      truncated = true;
      break;
    }
    const older = graphAt(c.commit);
    if (!older) {
      truncated = true;
      break;
    }
    if (newer && newerCommit) {
      for (const op of opsTouching(diffGraphs(older, newer), [id])) {
        if (entries.length >= maxOps) {
          truncated = true;
          break;
        }
        entries.push({ commit: newerCommit.commit, at: newerCommit.at, author: newerCommit.author, op: op.op, ...(op.target ? { target: op.target } : {}) });
      }
    }
    newer = older;
    newerCommit = c;
  }
  return { entries, truncated };
}
