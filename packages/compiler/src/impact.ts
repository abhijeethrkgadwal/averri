/**
 * `impact` (SPEC-MCP §6.4) and `diff`: what is affected when nodes change, with the dependsOn edge
 * path (≤ 2 hops) as the explanation. Three entry points: node ids, a unified diff (hunks mapped to
 * nodes through Module.contains and src/handler ranges), or two graphs (base/head).
 */

import {
  affectedBy,
  contractsWeakened as weakenedOps,
  diffGraphs,
  parseNodeId,
  type ActionNode,
  type ContractId,
  type ExposureNode,
  type Graph,
  type GraphDiff,
  type Node,
  type NodeId,
  type PolicyId,
  type QueryNode,
  type SourceRange,
  type TestId,
  type TestNode,
} from "@averri/ir";
import { changedLines, parseUnifiedDiff } from "./patch.js";
import { compareStrings } from "./util.js";

export interface ImpactResult {
  changed: NodeId[];
  affected: Array<{ id: NodeId; why: NodeId[]; verify?: string }>;
  testsToRun: Array<{ id: TestId; suite: string; file: string; covers: NodeId[] }>;
  migrationNeeded: boolean;
  apiBreaking: boolean;
  contractsWeakened: Array<{ contract: ContractId; op: "remove-contract" | "weaken-contract" | "change" }>;
  policiesRemoved: PolicyId[];
  diff?: GraphDiff;
  message?: string;
}

export type ResolvedId = { ok: true; id: NodeId } | { ok: false; error: "not-found" | "ambiguous"; candidates: NodeId[] };

/** Accept a full NodeId or a bare qualifier when exactly one node has it (SPEC-MCP §6). */
export function resolveNodeId(graph: Graph, idOrQualifier: string): ResolvedId {
  const s = idOrQualifier.trim();
  if (graph.nodes[s as NodeId]) return { ok: true, id: s as NodeId };
  const parsed = parseNodeId(s);
  if (parsed && graph.nodes[s as NodeId] === undefined && /^[A-Z][a-z]+:/.test(s)) {
    return { ok: false, error: "not-found", candidates: similarIds(graph, parsed.qualifier) };
  }
  const matches = (Object.keys(graph.nodes) as NodeId[]).filter((id) => id.slice(id.indexOf(":") + 1) === s).sort(compareStrings);
  if (matches.length === 1) return { ok: true, id: matches[0] as NodeId };
  if (matches.length > 1) return { ok: false, error: "ambiguous", candidates: matches };
  return { ok: false, error: "not-found", candidates: similarIds(graph, s) };
}

function similarIds(graph: Graph, q: string): NodeId[] {
  const lower = q.toLowerCase();
  return (Object.keys(graph.nodes) as NodeId[])
    .filter((id) => id.toLowerCase().includes(lower))
    .sort(compareStrings)
    .slice(0, 5);
}

/** `verify` note for an extracted node below 0.9 (SPEC-MCP §5), else undefined. */
export function verifyNote(n: Node | undefined): string | undefined {
  if (!n || n.provenance.origin !== "extracted" || n.provenance.confidence >= 0.9) return undefined;
  const where = n.src ? `read ${n.src.file}:${n.src.range[0][0]}` : "read the source";
  const why = n.provenance.evidence[0]?.note;
  return `${where}${why ? ` — ${why}` : ""} (confidence ${n.provenance.confidence < 0.6 ? "low" : "medium"})`.slice(0, 200);
}

function testsFor(graph: Graph, ids: Iterable<NodeId>, changedFiles: ReadonlySet<string>): ImpactResult["testsToRun"] {
  const set = new Set(ids);
  const out = new Map<TestId, TestNode>();
  for (const e of graph.edges) {
    if (e.kind === "verifiedBy" && set.has(e.from)) {
      const t = graph.nodes[e.to];
      if (t && t.kind === "Test") out.set(t.id as TestId, t as TestNode);
    }
  }
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== "Test") continue;
    const t = n as TestNode;
    if (set.has(t.id) || changedFiles.has(t.file) || t.covers.some((c) => set.has(c))) out.set(t.id as TestId, t);
  }
  return [...out.values()]
    .sort((a, b) => Number(b.generated) - Number(a.generated) || compareStrings(a.id, b.id))
    .map((t) => ({ id: t.id as TestId, suite: t.suite, file: t.file, covers: t.covers }));
}

function migration(graph: Graph, ids: Iterable<NodeId>): boolean {
  void graph;
  for (const id of ids) {
    const k = parseNodeId(id)?.kind;
    if (k === "Entity" || k === "Field") return true;
  }
  return false;
}

function finish(graph: Graph, changed: NodeId[], changedFiles: ReadonlySet<string>, extra: Partial<ImpactResult> = {}): ImpactResult {
  const sortedChanged = Array.from(new Set(changed)).sort(compareStrings);
  const affected = affectedBy(graph, sortedChanged)
    .filter((a) => !sortedChanged.includes(a.id))
    .map((a) => {
      const v = verifyNote(graph.nodes[a.id]);
      return v ? { id: a.id, why: a.why, verify: v } : { id: a.id, why: a.why };
    });
  // A changed Entity also changes the invariants stated on it (`Contract.of` is the Entity).
  const have = new Set<NodeId>([...sortedChanged, ...affected.map((a) => a.id)]);
  const changedSet = new Set<NodeId>(sortedChanged);
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== "Contract" || have.has(n.id) || !n.of.startsWith("Entity:") || !changedSet.has(n.of)) continue;
    const v = verifyNote(n);
    affected.push(v ? { id: n.id, why: [n.of], verify: v } : { id: n.id, why: [n.of] });
    have.add(n.id);
  }
  affected.sort((a, b) => compareStrings(a.id, b.id));
  const tests = testsFor(graph, [...sortedChanged, ...affected.map((a) => a.id)], changedFiles);
  return {
    changed: sortedChanged,
    affected,
    testsToRun: tests,
    migrationNeeded: extra.migrationNeeded ?? migration(graph, sortedChanged),
    apiBreaking: extra.apiBreaking ?? false,
    contractsWeakened: extra.contractsWeakened ?? [],
    policiesRemoved: extra.policiesRemoved ?? [],
    ...(extra.diff ? { diff: extra.diff } : {}),
    ...(extra.message ? { message: extra.message } : {}),
  };
}

/** Impact of changing the given nodes. */
export function impactOfIds(graph: Graph, ids: readonly NodeId[]): ImpactResult {
  return finish(graph, ids.filter((id) => graph.nodes[id]), new Set());
}

function overlaps(range: SourceRange["range"], lines: ReadonlyArray<[number, number]>): boolean {
  const [s, e] = [range[0][0], range[1][0]];
  return lines.some(([a, b]) => a <= e && b >= s);
}

/** Nodes touched by changed line ranges of one file (src spans and handler spans), plus the Module. */
export function nodesTouchedBy(graph: Graph, file: string, lines: ReadonlyArray<[number, number]>): NodeId[] {
  const out = new Set<NodeId>();
  const mod = `Module:${file}` as NodeId;
  for (const n of Object.values(graph.nodes)) {
    if (n.src && n.src.file === file && n.kind !== "Module" && overlaps(n.src.range, lines)) out.add(n.id);
    const h = (n as ActionNode | QueryNode).handler;
    if ((n.kind === "Action" || n.kind === "Query" || n.kind === "Exposure") && h && h.file === file && h.range && overlaps(h.range.range, lines)) out.add(n.id);
  }
  // Prefer the innermost declarations: a Contract inside an Action span keeps both (the Action changed too).
  if (graph.nodes[mod] && (out.size === 0 || lines.length > 0)) out.add(mod);
  return [...out];
}

/** Impact of a unified diff against the current graph (hunks → nodes). With `base`, also the structural diff. */
export function impactOfDiff(graph: Graph, unifiedDiff: string, base: Graph | null = null): ImpactResult {
  const files = changedLines(parseUnifiedDiff(unifiedDiff));
  const changed = new Set<NodeId>();
  const changedFiles = new Set<string>();
  for (const f of files) {
    changedFiles.add(f.file);
    if (f.newFile) for (const id of nodesTouchedBy(graph, f.newFile, f.newRanges)) changed.add(id);
    if (base && f.oldFile) for (const id of nodesTouchedBy(base, f.oldFile, f.oldRanges)) if (graph.nodes[id]) changed.add(id);
  }
  if (base) {
    const structural = impactOfGraphs(base, graph);
    for (const id of structural.changed) changed.add(id);
    return finish(graph, [...changed], changedFiles, {
      migrationNeeded: structural.migrationNeeded,
      apiBreaking: structural.apiBreaking,
      contractsWeakened: structural.contractsWeakened,
      policiesRemoved: structural.policiesRemoved,
      ...(structural.diff ? { diff: structural.diff } : {}),
    });
  }
  return finish(graph, [...changed], changedFiles, files.length === 0 ? { message: "nothing changed" } : {});
}

/** Structural impact between two builds (SPEC-IR §7 diff + SPEC-MCP §6.4 flags). */
export function impactOfGraphs(base: Graph, head: Graph): ImpactResult {
  const diff = diffGraphs(base, head);
  const changed = new Set<NodeId>();
  for (const op of diff.ops) {
    if (op.op === "add-edge" || op.op === "remove-edge") continue;
    if (head.nodes[op.node]) changed.add(op.node);
    if (op.target && head.nodes[op.target as NodeId]) changed.add(op.target as NodeId);
  }
  const removedIds = diff.ops.filter((o) => o.op === "remove").map((o) => o.node);
  const policiesRemoved = removedIds.filter((id) => id.startsWith("Policy:")).sort(compareStrings) as PolicyId[];
  const touched = [...changed, ...removedIds];
  const migrationNeeded = touched.some((id) => id.startsWith("Field:") || (id.startsWith("Entity:") && diff.ops.some((o) => o.node === id && (o.op === "add" || o.op === "remove" || o.op === "rename"))));
  return finish(head, [...changed], new Set(), {
    migrationNeeded,
    apiBreaking: apiBreaking(base, head, diff),
    contractsWeakened: weakenedOps(diff),
    policiesRemoved,
    diff,
    ...(diff.ops.length === 0 ? { message: "nothing changed" } : {}),
  });
}

function routeKey(n: ActionNode | QueryNode): string {
  return n.route ? `${n.route.method} ${n.route.path}` : "";
}

/** Multiset of `METHOD path` over the Exposures of a graph. */
function exposureSurface(graph: Graph): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== "Exposure") continue;
    const key = `${(n as ExposureNode).method} ${(n as ExposureNode).path}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Route removed or changed (method/path), input field removed, or a field of an output entity removed.
 *
 * Exposure ids embed `line:col`, so adding an import moves every registration below it and the diff
 * pairs unrelated registrations by id. The HTTP surface is therefore compared as the multiset of
 * `METHOD path` pairs, not through the diff ops: a registration that only moved is not breaking, a
 * removed or edited method/path is (D-41g). Not detected in V0: a narrowed input type (the IR keeps
 * field names, not their Zod types).
 */
export function apiBreaking(base: Graph, head: Graph, diff: GraphDiff): boolean {
  const headSurface = exposureSurface(head);
  for (const [key, count] of exposureSurface(base)) if ((headSurface.get(key) ?? 0) < count) return true;
  for (const op of diff.ops) {
    const kind = parseNodeId(op.node)?.kind;
    if (op.op === "remove" && (kind === "Action" || kind === "Query") && (base.nodes[op.node] as ActionNode | undefined)?.route) return true;
    // An Action/Query rename moves an id; it breaks the API only when its route differs.
    if (op.op === "rename" && (kind === "Action" || kind === "Query")) {
      const before = base.nodes[op.target as NodeId] as ActionNode | QueryNode | undefined;
      const after = head.nodes[op.node] as ActionNode | QueryNode | undefined;
      if (!before || !after || routeKey(before) !== routeKey(after)) return true;
      continue;
    }
    if (op.op === "change" && (kind === "Action" || kind === "Query")) {
      // `route.exposure` / `route.verified` follow the Exposure's id (line:col) and say nothing about the API.
      if (op.target === "route.method" || op.target === "route.path" || (op.target === "route" && op.before !== null && op.before !== undefined)) return true;
      const b = base.nodes[op.node] as ActionNode | undefined;
      const h = head.nodes[op.node] as ActionNode | undefined;
      if (b && h && b.input.fields.some((f) => !h.input.fields.includes(f))) return true;
    }
    if (op.op === "remove" && kind === "Field") {
      const entity = op.node.slice("Field:".length).split(".")[0];
      const outputs = Object.values(base.nodes).some((n) => (n.kind === "Action" || n.kind === "Query") && "entity" in (n as ActionNode).output && ((n as ActionNode).output as { entity: string }).entity === `Entity:${entity}`);
      if (outputs) return true;
    }
  }
  return false;
}

/** `diff(graphA, graphB)`: the structural GraphDiff (SPEC-IR §7). */
export function diff(a: Graph, b: Graph): GraphDiff {
  return diffGraphs(a, b);
}
