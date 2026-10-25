/**
 * `impact` tool data (SPEC-MCP §6.4) with input resolution and the 1 500-token budget: `{id}`,
 * `{diff}` (the working tree vs the tree with the diff reverted), `{base}` (git ref vs working tree),
 * `{}` (dirty: HEAD vs working tree; clean: last green vs HEAD; neither: "nothing changed").
 */

import type { Graph, NodeId } from "@averri/ir";
import { readLastGreenGraph } from "../cache.js";
import { gitInfo } from "../git.js";
import { impactOfDiff, impactOfGraphs, impactOfIds, resolveNodeId, verifyNote, type ImpactResult } from "../impact.js";
import { buildAtRef, buildWithDiffReverted } from "../revisions.js";
import { BUDGETS, capMore, responseTokens, type QueryResult } from "./budget.js";

export interface ImpactInput {
  id?: string;
  diff?: string;
  base?: string;
}

export interface ImpactQueryOptions {
  root?: string;
  /** Pre-built base graph (tests, or a caller that already has one). */
  baseGraph?: Graph | null;
  git?: boolean;
}

function emptyImpact(message: string): ImpactResult {
  return { changed: [], affected: [], testsToRun: [], migrationNeeded: false, apiBreaking: false, contractsWeakened: [], policiesRemoved: [], message };
}

export function impactQuery(graph: Graph, input: ImpactInput, options: ImpactQueryOptions = {}): QueryResult<ImpactResult> {
  const root = options.root ?? graph.meta.root;
  const given = [input.id, input.diff, input.base].filter((x) => x !== undefined).length;
  if (given > 1) return { ok: false, error: "bad-input", message: "at most one of id, diff, base" };
  let result: ImpactResult;
  if (input.id !== undefined) {
    const r = resolveNodeId(graph, input.id);
    if (!r.ok) return { ok: false, error: r.error, message: r.error === "ambiguous" ? `${input.id} matches several nodes` : `no node ${input.id}`, candidates: r.candidates };
    const v = verifyNote(graph.nodes[r.id]);
    if (v) return { ok: false, error: "low-confidence", message: `${r.id} is an extracted fact below confidence 0.9: ${v}`, candidates: [r.id] };
    result = impactOfIds(graph, [r.id]);
  } else if (input.diff !== undefined) {
    let base: Graph | null = options.baseGraph ?? null;
    if (options.baseGraph === undefined) {
      try {
        base = buildWithDiffReverted(root, input.diff);
      } catch (e) {
        return { ok: false, error: "bad-input", message: `the diff does not apply to the working tree in reverse: ${(e as Error).message}` };
      }
    }
    result = impactOfDiff(graph, input.diff, base);
  } else if (input.base !== undefined) {
    const base = options.baseGraph !== undefined ? options.baseGraph : buildAtRef(root, input.base);
    if (!base) return { ok: false, error: "bad-input", message: `cannot build ${input.base}: not a git ref of this repository` };
    result = impactOfGraphs(base, graph);
  } else {
    let base: Graph | null = options.baseGraph ?? null;
    if (options.baseGraph === undefined) {
      const info = options.git === false ? { commit: null, dirty: false } : gitInfo(root);
      base = info.commit && info.dirty ? buildAtRef(root, "HEAD") : readLastGreenGraph(root);
    }
    result = base ? impactOfGraphs(base, graph) : emptyImpact("nothing changed");
  }
  return boundImpact(result);
}

/** testsToRun <= 20 (rest in `more`), then diff ops, affected entries, from the end. */
export function boundImpact(result: ImpactResult): { ok: true; data: ImpactResult; truncated: boolean; more?: string[] } {
  const data: ImpactResult = { ...result, affected: [...result.affected], testsToRun: [...result.testsToRun], ...(result.diff ? { diff: { ...result.diff, ops: [...result.diff.ops] } } : {}) };
  const more: string[] = [];
  let truncated = false;
  while (data.testsToRun.length > 20) {
    more.push((data.testsToRun.pop() as { id: string }).id);
    truncated = true;
  }
  const over = (): boolean => responseTokens(data, more) > BUDGETS.impact;
  while (over() && data.diff && data.diff.ops.length > 0) {
    data.diff.ops.pop();
    truncated = true;
  }
  while (over() && data.testsToRun.length > 0) {
    more.push((data.testsToRun.pop() as { id: string }).id);
    truncated = true;
  }
  while (over() && data.affected.length > 0) {
    more.push((data.affected.pop() as { id: NodeId }).id);
    truncated = true;
  }
  return more.length ? { ok: true, data, truncated, more: capMore(more) } : { ok: true, data, truncated };
}
