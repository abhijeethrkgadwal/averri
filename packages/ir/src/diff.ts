/**
 * Structural graph diff (SPEC-IR §7): add/remove/rename for nodes, `change` with dotted paths for
 * payload differences, contract ops attributed to the owner (with the weakening rule), and edge ops
 * for non-`dependsOn` edges. Deterministic; pure; no IO.
 */

import type { ContractNode, Edge, Graph, GraphDiff, GraphDiffOp, GraphDiffOpKind, Node, NodeId, NodeKind } from "./types.js";
import { canonicalJson } from "./ast.js";
import { edgeKey } from "./edges.js";
import { sortedNodeIds } from "./graph.js";
import { compareIds, parseContractId, parseNodeId, parseTestId } from "./ids.js";
import { classifyContractChange } from "./weaken.js";

export interface DiffOptions {
  /**
   * Top-level node properties whose differences are not reported as `change` ops. Default:
   * `src`, `provenance`, `summary` (they move with every edit) and `lastResult` (written by `check`,
   * not by `build`). Pass `[]` to report everything.
   */
  ignore?: readonly string[];
}

export const DEFAULT_DIFF_IGNORE: readonly string[] = ["src", "provenance", "summary", "lastResult"];

/** Op kinds in the order they are listed per node. */
const OP_ORDER: Readonly<Record<GraphDiffOpKind, number>> = {
  rename: 0,
  remove: 1,
  add: 2,
  "remove-contract": 3,
  "add-contract": 4,
  "weaken-contract": 5,
  "strengthen-contract": 6,
  change: 7,
  "remove-edge": 8,
  "add-edge": 9,
};

export function compareDiffOps(a: GraphDiffOp, b: GraphDiffOp): number {
  return compareIds(a.node, b.node) || OP_ORDER[a.op] - OP_ORDER[b.op] || compareIds(a.target ?? "", b.target ?? "");
}

/**
 * Diff two graphs. `base` is the older state. Implements rename detection (same `handler` symbol for
 * Actions/Queries, same `src.file` + method + path for Exposures; tie rule: a key shared by two nodes on
 * either side yields no rename) and propagates renames to the owner's Contracts and generated Tests.
 */
export function diffGraphs(base: Graph, head: Graph, options: DiffOptions = {}): GraphDiff {
  const ignore = new Set(options.ignore ?? DEFAULT_DIFF_IGNORE);
  const ops: GraphDiffOp[] = [];
  const baseIds = sortedNodeIds(base.nodes);
  const headIds = sortedNodeIds(head.nodes);
  const removed = baseIds.filter((id) => !head.nodes[id]);
  const added = headIds.filter((id) => !base.nodes[id]);

  const renames = detectRenames(base, head, removed, added);
  const renamedBase = new Set(renames.keys());
  const renamedHead = new Set(renames.values());

  // Node ops.
  for (const oldId of removed) {
    if (renamedBase.has(oldId)) continue;
    const node = base.nodes[oldId]!;
    ops.push(node.kind === "Contract" ? contractOp("remove-contract", node) : { op: "remove", node: oldId });
  }
  for (const newId of added) {
    if (renamedHead.has(newId)) continue;
    const node = head.nodes[newId]!;
    ops.push(node.kind === "Contract" ? contractOp("add-contract", node) : { op: "add", node: newId });
  }
  const pairs: Array<[Node, Node]> = [];
  for (const [oldId, newId] of renames) {
    ops.push({ op: "rename", node: newId, target: oldId });
    pairs.push([base.nodes[oldId]!, head.nodes[newId]!]);
  }
  for (const id of baseIds) if (head.nodes[id]) pairs.push([base.nodes[id]!, head.nodes[id]!]);

  for (const [before, after] of pairs) {
    const skip = new Set(ignore);
    skip.add("id");
    if (before.id !== after.id) skip.add("name");
    if (before.kind === "Contract" && after.kind === "Contract") {
      const kind = classifyContractChange(before, after);
      if (kind !== "equal") {
        ops.push({
          op: kind,
          node: after.of,
          target: after.id,
          before: { tier: before.tier, expr: before.expr },
          after: { tier: after.tier, expr: after.expr },
        });
      }
      skip.add("expr");
      skip.add("tier");
      skip.add("opaque");
    }
    for (const change of diffValues(before, after, skip)) ops.push({ op: "change", node: after.id, ...change });
  }

  // Edge ops (non-dependsOn), with base endpoints mapped through renames.
  const mapId = (id: NodeId): NodeId => renames.get(id) ?? id;
  const baseEdges = new Map<string, Edge>();
  for (const e of base.edges) {
    if (e.kind === "dependsOn") continue;
    const mapped: Edge = { ...e, from: mapId(e.from), to: mapId(e.to) };
    baseEdges.set(edgeKey(mapped), mapped);
  }
  const headEdges = new Map<string, Edge>();
  for (const e of head.edges) if (e.kind !== "dependsOn") headEdges.set(edgeKey(e), e);
  for (const [key, e] of baseEdges) if (!headEdges.has(key)) ops.push({ op: "remove-edge", node: e.from, target: key });
  for (const [key, e] of headEdges) if (!baseEdges.has(key)) ops.push({ op: "add-edge", node: e.from, target: key });

  ops.sort(compareDiffOps);
  return {
    base: { commit: base.meta.commit, contentHash: base.meta.contentHash },
    head: { commit: head.meta.commit, contentHash: head.meta.contentHash },
    ops,
  };
}

function contractOp(op: "add-contract" | "remove-contract", node: ContractNode): GraphDiffOp {
  const payload = { tier: node.tier, expr: node.expr };
  return op === "add-contract" ? { op, node: node.of, target: node.id, after: payload } : { op, node: node.of, target: node.id, before: payload };
}

// --- rename detection ------------------------------------------------------------------

/** Rename key of a node, or null when the kind has none. */
export function renameKey(node: Node): string | null {
  switch (node.kind) {
    case "Action":
    case "Query":
      return node.handler ? `${node.kind}|${node.handler.file}|${node.handler.symbol}` : null;
    case "Exposure":
      return node.src ? `Exposure|${node.src.file}|${node.method}|${node.path}` : null;
    default:
      return null;
  }
}

function keyCounts(nodes: Readonly<Record<string, Node>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of Object.values(nodes)) {
    const k = renameKey(n);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** old id -> new id. */
function detectRenames(base: Graph, head: Graph, removed: readonly NodeId[], added: readonly NodeId[]): Map<NodeId, NodeId> {
  const renames = new Map<NodeId, NodeId>();
  const baseCounts = keyCounts(base.nodes);
  const headCounts = keyCounts(head.nodes);
  const addedByKey = new Map<string, NodeId>();
  for (const id of added) {
    const k = renameKey(head.nodes[id]!);
    if (k && headCounts.get(k) === 1) addedByKey.set(k, id);
  }
  for (const id of removed) {
    const k = renameKey(base.nodes[id]!);
    if (!k || baseCounts.get(k) !== 1) continue;
    const target = addedByKey.get(k);
    if (target) renames.set(id, target);
  }
  // Propagate to Contracts and generated Tests owned by a renamed declaration.
  const ownerRenames = [...renames.entries()]
    .map(([o, n]) => [parseNodeId(o)!, parseNodeId(n)!] as const)
    .filter(([o, n]) => o.kind === n.kind && (o.kind === "Action" || o.kind === "Query" || o.kind === "Policy"));
  if (ownerRenames.length === 0) return renames;
  const addedSet = new Set(added);
  for (const id of removed) {
    if (renames.has(id)) continue;
    const node = base.nodes[id]!;
    const mapped = mapOwnedId(node, ownerRenames);
    if (mapped && addedSet.has(mapped) && head.nodes[mapped]?.kind === node.kind) renames.set(id, mapped);
  }
  return renames;
}

function mapOwnedId(node: Node, ownerRenames: ReadonlyArray<readonly [{ kind: NodeKind; qualifier: string }, { kind: NodeKind; qualifier: string }]>): NodeId | null {
  if (node.kind === "Contract") {
    const c = parseContractId(node.id);
    if (!c) return null;
    for (const [o, n] of ownerRenames) {
      if (c.ownerQualifier === o.qualifier) {
        return c.phase === "allow" ? `Contract:${n.qualifier}.allow` : `Contract:${n.qualifier}.${c.phase}.${c.clause}`;
      }
    }
    return null;
  }
  if (node.kind === "Test" && node.generated) {
    const t = parseTestId(node.id);
    if (!t || !t.generated) return null;
    for (const [o, n] of ownerRenames) if (t.ownerQualifier === o.qualifier) return `Test:gen/${n.qualifier}.${t.suite}`;
    return null;
  }
  return null;
}

// --- value diff --------------------------------------------------------------------

export interface ValueChange {
  /** Dotted property path (`route.path`, `effects.declared`). */
  target: string;
  before: unknown;
  after: unknown;
}

/**
 * Differences between two JSON-like objects as dotted paths. Objects recurse; arrays and scalars are
 * leaves (reported whole). `skipTopLevel` names top-level keys to ignore.
 */
export function diffValues(before: unknown, after: unknown, skipTopLevel: ReadonlySet<string> = new Set()): ValueChange[] {
  const out: ValueChange[] = [];
  const walk = (b: unknown, a: unknown, path: string[]): void => {
    if (isPlainObject(b) && isPlainObject(a)) {
      const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort(compareIds);
      for (const key of keys) {
        if (path.length === 0 && skipTopLevel.has(key)) continue;
        const bv = b[key];
        const av = a[key];
        if (bv === undefined && av === undefined) continue;
        walk(bv, av, [...path, key]);
      }
      return;
    }
    if (canonicalJson(b) !== canonicalJson(a)) out.push({ target: path.join("."), before: b, after: a });
  };
  walk(before, after, []);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- summaries ----------------------------------------------------------------------------

const KIND_LABEL: Readonly<Record<NodeKind, string>> = {
  Entity: "entity",
  Field: "field",
  Action: "action",
  Query: "query",
  Policy: "policy",
  Contract: "contract",
  Event: "event",
  Workflow: "workflow",
  Integration: "integration",
  Exposure: "route",
  Test: "test",
  Module: "module",
};

const KIND_ORDER: Readonly<Record<NodeKind, number>> = Object.fromEntries(Object.keys(KIND_LABEL).map((k, i) => [k, i])) as Record<NodeKind, number>;

/**
 * The `since_last_green` style summary: `"+1 action, +1 route, ~1 contract"`. Counts are distinct
 * nodes per sign and kind; edge ops are not counted; renames and changes count as `~`. Optionally restricted to ops whose `node` or contract
 * `target` is in `only`. Returns `"no changes"` when nothing qualifies.
 */
export function summarizeGraphDiff(diff: GraphDiff, only?: ReadonlySet<NodeId> | readonly NodeId[]): string {
  const filter = only ? new Set(only) : null;
  const buckets = new Map<string, { kind: NodeKind; sign: "+" | "-" | "~"; ids: Set<string> }>();
  for (const op of diff.ops) {
    if (op.op === "add-edge" || op.op === "remove-edge") continue;
    const isContractOp = op.op.endsWith("-contract");
    const subject = isContractOp ? (op.target as NodeId) : op.node;
    if (filter && !filter.has(op.node) && !(isContractOp && filter.has(subject))) continue;
    const kind = parseNodeId(subject)?.kind;
    if (!kind) continue;
    const sign: "+" | "-" | "~" = op.op === "add" || op.op === "add-contract" ? "+" : op.op === "remove" || op.op === "remove-contract" ? "-" : "~";
    const key = `${sign}${kind}`;
    const b = buckets.get(key) ?? { kind, sign, ids: new Set<string>() };
    b.ids.add(subject);
    buckets.set(key, b);
  }
  if (buckets.size === 0) return "no changes";
  const signOrder = { "+": 0, "-": 1, "~": 2 } as const;
  return [...buckets.values()]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || signOrder[a.sign] - signOrder[b.sign])
    .map((b) => `${b.sign}${b.ids.size} ${KIND_LABEL[b.kind]}${b.ids.size === 1 ? "" : "s"}`)
    .join(", ");
}

/** Contract ops that matter for `contractsWeakened` (remove, weaken, undecided change of a contract AST). */
export function contractsWeakened(diff: GraphDiff): Array<{ contract: `Contract:${string}`; op: "remove-contract" | "weaken-contract" | "change" }> {
  const out: Array<{ contract: `Contract:${string}`; op: "remove-contract" | "weaken-contract" | "change" }> = [];
  for (const op of diff.ops) {
    if (op.op === "remove-contract" || op.op === "weaken-contract") out.push({ contract: op.target as `Contract:${string}`, op: op.op });
    else if (op.op === "change" && typeof op.target === "string" && op.target.startsWith("Contract:")) out.push({ contract: op.target as `Contract:${string}`, op: "change" });
  }
  return out;
}

/** Ops touching any of `ids` (as `node`, rename `target`, or contract `target`). */
export function opsTouching(diff: GraphDiff, ids: ReadonlySet<NodeId> | readonly NodeId[]): GraphDiffOp[] {
  const set = new Set(ids);
  return diff.ops.filter((op) => set.has(op.node) || (op.target !== undefined && set.has(op.target as NodeId)));
}
