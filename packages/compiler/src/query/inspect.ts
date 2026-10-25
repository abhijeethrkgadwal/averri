/**
 * `inspect` (SPEC-MCP §6.3): everything about one node, <= 2 000 tokens. Refuses (low-confidence) when
 * the node itself is an extracted fact below 0.9. Truncation order: source, history entries, tests,
 * dependents, the longest edge lists, diagnostics.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dependentsOf, groupEdgesByKind, type Diagnostic, type EdgeKind, type Graph, type HistoryEntry, type Node, type NodeId, type TestId, type TestNode, type TestResultSummary } from "@averri/ir";
import { specCard, type SpecCard } from "../cards.js";
import { nodeHistory, type HistoryOptions } from "../history.js";
import { resolveNodeId, verifyNote } from "../impact.js";
import { compareStrings, tokensOf } from "../util.js";
import { BUDGETS, capMore, responseTokens, type QueryResult } from "./budget.js";

export interface InspectInput {
  id: string;
  include?: Array<"source" | "history" | "tests">;
}

export interface InspectData {
  node: Node;
  verify?: string;
  card: SpecCard;
  edges: Partial<Record<EdgeKind, NodeId[]>>;
  dependents: NodeId[];
  tests?: Array<{ id: TestId; suite: string; file: string; lastResult: TestResultSummary | null }>;
  history?: { entries: HistoryEntry[]; truncated: boolean };
  source?: string;
  diagnostics: Diagnostic[];
}

export interface InspectOptions {
  /** Project root for `source` and `history`. Default `graph.meta.root`. */
  root?: string;
  history?: HistoryOptions;
}

export function inspect(graph: Graph, input: InspectInput, options: InspectOptions = {}): QueryResult<InspectData> {
  const r = resolveNodeId(graph, input.id);
  if (!r.ok) return { ok: false, error: r.error, message: r.error === "ambiguous" ? `${input.id} matches several nodes` : `no node ${input.id}`, candidates: r.candidates };
  const id = r.id;
  const node = graph.nodes[id] as Node;
  const verify = verifyNote(node);
  if (verify) return { ok: false, error: "low-confidence", message: `${id} is an extracted fact below confidence 0.9: ${verify}`, candidates: [id] };
  const include = new Set(input.include ?? []);
  const root = options.root ?? graph.meta.root;
  const more: string[] = [];
  const data: InspectData = {
    node,
    card: specCard(graph, id) as SpecCard,
    edges: groupEdgesByKind(graph.edges.filter((e) => e.kind !== "dependsOn"), id),
    dependents: dependentsOf(graph, id).slice(0, 20),
    diagnostics: graph.diagnostics.filter((d) => d.node === id || d.cause.some((c) => c.node === id)),
  };
  if (include.has("tests")) {
    const ids = new Set<NodeId>(graph.edges.filter((e) => e.kind === "verifiedBy" && e.from === id).map((e) => e.to));
    for (const n of Object.values(graph.nodes)) if (n.kind === "Test" && (n as TestNode).covers.includes(id)) ids.add(n.id);
    data.tests = [...ids]
      .map((t) => graph.nodes[t] as TestNode | undefined)
      .filter((t): t is TestNode => !!t && t.kind === "Test")
      .sort((a, b) => compareStrings(a.id, b.id))
      .map((t) => ({ id: t.id as TestId, suite: t.suite, file: t.file, lastResult: t.lastResult }));
  }
  if (include.has("history")) data.history = nodeHistory(root, graph, id, options.history);
  if (include.has("source") && node.src) {
    const abs = path.join(root, node.src.file);
    if (fs.existsSync(abs)) {
      const lines = fs.readFileSync(abs, "utf8").split("\n").slice(node.src.range[0][0] - 1, node.src.range[1][0]);
      const text = lines.join("\n");
      if (tokensOf(text) <= 400) data.source = text;
      else more.push(`${node.src.file}:${node.src.range[0][0]}-${node.src.range[1][0]}`);
    }
  }
  let truncated = false;
  const over = (): boolean => responseTokens(data, more) > BUDGETS.inspect;
  if (over() && data.source !== undefined) {
    more.push(`${node.src?.file}:${node.src?.range[0][0]}-${node.src?.range[1][0]}`);
    delete data.source;
    truncated = true;
  }
  while (over() && data.history && data.history.entries.length > 0) {
    data.history.entries.pop();
    data.history.truncated = true;
    truncated = true;
  }
  while (over() && data.tests && data.tests.length > 0) {
    more.push((data.tests.pop() as { id: string }).id);
    truncated = true;
  }
  while (over() && data.dependents.length > 0) {
    more.push(data.dependents.pop() as string);
    truncated = true;
  }
  while (over()) {
    const longest = (Object.entries(data.edges) as Array<[EdgeKind, NodeId[]]>).sort((a, b) => b[1].length - a[1].length || compareStrings(a[0], b[0]))[0];
    if (!longest || longest[1].length <= 1) break;
    more.push(longest[1].pop() as string);
    truncated = true;
  }
  while (over() && data.diagnostics.length > 0) {
    data.diagnostics.pop();
    truncated = true;
  }
  if (verify) data.verify = verify;
  return more.length ? { ok: true, data, truncated, more: capMore(more) } : { ok: true, data, truncated };
}
