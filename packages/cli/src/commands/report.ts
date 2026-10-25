/**
 * `averri report --base <ref>`: impact and diagnostics of the working tree against a git ref.
 * Written to `.averri/reports/<sha>.json` so the human rendering can be repeated later (ARCHITECTURE §4).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildAtRef, diff as graphDiff, impactOfGraphs, loadOrBuild, type ImpactResult } from "@averri/compiler";
import { summarizeGraphDiff, type Diagnostic, type Graph } from "@averri/ir";

export interface Report {
  ok: true;
  base: { ref: string; commit: string | null; contentHash: string };
  head: { commit: string | null; dirty: boolean; contentHash: string };
  summary: string;
  impact: Omit<ImpactResult, "diff">;
  diagnostics: {
    counts: { errors: number; warnings: number; infos: number };
    introduced: Diagnostic[];
    resolved: Array<{ code: string; node: string | null; title: string }>;
    /** True when `introduced` was cut at 50 entries. */
    truncated: boolean;
  };
}

export type ReportResult = Report | { ok: false; error: "bad-input"; message: string };

const key = (d: Pick<Diagnostic, "code" | "node" | "title">): string => `${d.code}|${d.node ?? ""}|${d.title}`;

export function buildReport(head: Graph, base: Graph, ref: string): Report {
  const d = graphDiff(base, head);
  const { diff: _drop, ...impact } = impactOfGraphs(base, head);
  const baseKeys = new Set(base.diagnostics.map(key));
  const headKeys = new Set(head.diagnostics.map(key));
  const introduced = head.diagnostics.filter((x) => !baseKeys.has(key(x)));
  const resolved = base.diagnostics.filter((x) => !headKeys.has(key(x))).map((x) => ({ code: x.code, node: x.node, title: x.title }));
  const count = (s: Diagnostic["severity"]): number => head.diagnostics.filter((x) => x.severity === s).length;
  return {
    ok: true,
    base: { ref, commit: base.meta.commit, contentHash: base.meta.contentHash },
    head: { commit: head.meta.commit, dirty: head.meta.dirty, contentHash: head.meta.contentHash },
    summary: summarizeGraphDiff(d),
    impact,
    diagnostics: { counts: { errors: count("error"), warnings: count("warning"), infos: count("info") }, introduced: introduced.slice(0, 50), resolved, truncated: introduced.length > 50 },
  };
}

export async function report(root: string, ref: string, write = true): Promise<ReportResult> {
  const head = await loadOrBuild(root);
  const base = buildAtRef(root, ref);
  if (!base) return { ok: false, error: "bad-input", message: `cannot build ${ref}: not a git ref of this repository` };
  const r = buildReport(head, base, ref);
  if (write) {
    const sha = (head.meta.commit ?? head.meta.contentHash).slice(0, 12);
    const file = path.join(root, ".averri", "reports", `${sha}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  return r;
}
