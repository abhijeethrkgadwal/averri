/**
 * Spec cards (SPEC-MCP §6.3 `SpecCard`, SPEC-DECLARATIONS §7 Markdown, <= 15 lines) and the
 * `.averri/cards/<encodeURIComponent(id)>.md` files (D-24).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  nodeIdToFileName,
  type ActionNode,
  type ContractNode,
  type ContractTier,
  type Edge,
  type EntityNode,
  type EventNode,
  type Graph,
  type Node,
  type NodeId,
  type PolicyNode,
  type QueryNode,
  type TestNode,
  type WorkflowNode,
} from "@averri/ir";
import { cachePath } from "./cache.js";
import { renderClause } from "./render.js";
import { compareStrings } from "./util.js";

export interface SpecCard {
  intent: string | null;
  whoMay: string;
  preconditions: Array<{ clause: string; tier: ContractTier; text: string }>;
  postconditions: Array<{ clause: string; tier: ContractTier; text: string }>;
  invariants: Array<{ clause: string; text: string }>;
  effects: string[];
  tests: string[];
  owner: string | null;
  lastChange: string | null;
}

function q(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

function edgesFrom(graph: Graph, id: NodeId, kind: Edge["kind"]): NodeId[] {
  return Array.from(new Set(graph.edges.filter((e) => e.kind === kind && e.from === id).map((e) => e.to))).sort(compareStrings);
}

function edgesTo(graph: Graph, id: NodeId, kind: Edge["kind"]): NodeId[] {
  return Array.from(new Set(graph.edges.filter((e) => e.kind === kind && e.to === id).map((e) => e.from))).sort(compareStrings);
}

function contractText(c: ContractNode): string {
  return c.expr ? renderClause(c.expr) : "opaque guard";
}

function status(n: Node): string {
  return n.provenance.origin === "verified" ? "verified" : n.provenance.origin;
}

export function whoMay(graph: Graph, n: ActionNode | QueryNode): string {
  if (n.public) return "public";
  if (!n.policy) return "no policy";
  const p = graph.nodes[n.policy] as PolicyNode | undefined;
  if (!p) return q(n.policy);
  const allow = graph.nodes[p.allow] as ContractNode | undefined;
  if (!allow || allow.tier === "guard") return `${p.name} — opaque`;
  return `${p.name} — ${contractText(allow)}`;
}

function testSummary(graph: Graph, owner: NodeId): string[] {
  const tests = edgesFrom(graph, owner, "verifiedBy")
    .map((id) => graph.nodes[id])
    .filter((t): t is TestNode => !!t && t.kind === "Test");
  const bySuite = new Map<string, TestNode[]>();
  for (const t of tests) bySuite.set(t.suite, [...(bySuite.get(t.suite) ?? []), t]);
  return [...bySuite.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([suite, ts]) => {
      const results = ts.map((t) => t.lastResult?.status ?? "not run");
      const st = results.every((r) => r === "passed") ? "green" : results.some((r) => r === "failed") ? "failing" : results.every((r) => r === "not run") ? "not run" : "partial";
      return `${suite} (${ts.length}) ${ts.every((t) => t.generated) ? "generated" : "hand-written"}, ${st}`;
    });
}

function effectsOf(graph: Graph, n: Node): string[] {
  const out: string[] = [];
  const writes = edgesFrom(graph, n.id, "writes");
  if (writes.length) out.push(`writes ${writes.map(q).join(", ")}`);
  const reads = new Map<string, Set<string>>();
  const addRead = (ent: NodeId, why: string): void => {
    const s = reads.get(ent) ?? new Set<string>();
    s.add(why);
    reads.set(ent, s);
  };
  for (const r of edgesFrom(graph, n.id, "reads")) addRead(r, "handler");
  if (n.kind === "Action" || n.kind === "Query") {
    const d = n as ActionNode | QueryNode;
    if (d.policy) for (const r of edgesFrom(graph, d.policy, "reads")) addRead(r, "policy");
    const contracts = n.kind === "Action" ? (n as ActionNode).contracts : [];
    for (const c of contracts) {
      const cn = graph.nodes[c] as ContractNode | undefined;
      if (!cn) continue;
      for (const r of edgesFrom(graph, c, "reads")) addRead(r, cn.phase);
    }
  }
  if (reads.size) out.push(`reads ${[...reads.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([e, why]) => `${q(e)} (${[...why].join(", ")})`).join(", ")}`);
  for (const ev of edgesFrom(graph, n.id, "emits")) {
    const consumers = edgesFrom(graph, ev, "consumedBy").map(q);
    out.push(`emits ${q(ev)}${consumers.length ? ` → ${consumers.join(", ")}` : ""}`);
  }
  const calls = edgesFrom(graph, n.id, "calls");
  if (calls.length) out.push(`calls ${calls.map(q).join(", ")}`);
  return out;
}

/** The structured card for any node (SPEC-MCP §6.3). */
export function specCard(graph: Graph, id: NodeId): SpecCard | null {
  const n = graph.nodes[id];
  if (!n) return null;
  const card: SpecCard = {
    intent: n.intent ?? null,
    whoMay: "—",
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: effectsOf(graph, n),
    tests: testSummary(graph, id),
    owner: n.owner ?? null,
    lastChange: null,
  };
  if (n.kind === "Action" || n.kind === "Query") {
    card.whoMay = whoMay(graph, n as ActionNode | QueryNode);
    if (n.kind === "Action") {
      for (const cid of (n as ActionNode).contracts) {
        const c = graph.nodes[cid] as ContractNode | undefined;
        if (!c) continue;
        const entry = { clause: c.clause, tier: c.tier, text: contractText(c) };
        if (c.phase === "requires") card.preconditions.push(entry);
        else card.postconditions.push(entry);
      }
    }
  } else if (n.kind === "Entity") {
    for (const cid of (n as EntityNode).invariants) {
      const c = graph.nodes[cid] as ContractNode | undefined;
      if (c) card.invariants.push({ clause: c.clause, text: contractText(c) });
    }
    const writers = edgesTo(graph, id, "writes");
    if (writers.length) card.effects.push(`written by ${writers.map(q).join(", ")}`);
  } else if (n.kind === "Policy") {
    const allow = graph.nodes[(n as PolicyNode).allow] as ContractNode | undefined;
    card.whoMay = allow ? (allow.tier === "guard" ? "opaque" : contractText(allow)) : "—";
  } else if (n.kind === "Event") {
    const ev = n as EventNode;
    card.effects.push(`payload ${Object.entries(ev.payload).map(([k, v]) => `${k}: ${v}`).join(", ") || "{}"}`);
    const consumers = edgesFrom(graph, id, "consumedBy");
    card.effects.push(consumers.length ? `consumed by ${consumers.map(q).join(", ")}` : ev.external ? "consumed outside this repo" : "no consumer");
  } else if (n.kind === "Workflow") {
    const w = n as WorkflowNode;
    card.effects.push(`on ${q(w.on)} (${w.engine})${w.steps.length ? `, steps ${w.steps.join(", ")}` : ""}`);
  }
  return card;
}

const MAX_CARD_LINES = 15;

/** The Markdown card (<= 15 lines). */
export function renderCardMarkdown(graph: Graph, id: NodeId): string | null {
  const n = graph.nodes[id];
  const card = specCard(graph, id);
  if (!n || !card) return null;
  const lines: string[] = [];
  const route = (n.kind === "Action" || n.kind === "Query") && (n as ActionNode).route ? ` — ${(n as ActionNode).route?.method} ${(n as ActionNode).route?.path}` : "";
  lines.push(`## ${n.name}${route}`);
  if (card.intent) lines.push(`Intent: ${card.intent}`);
  const tag = `   [${status(n)}]`;
  if (n.kind === "Action" || n.kind === "Query" || n.kind === "Policy") lines.push(`Who may: ${card.whoMay}${n.kind === "Policy" ? "" : tag}`);
  const clauseLines = (label: string, items: Array<{ clause: string; tier?: ContractTier; text: string }>): string[] => {
    if (!items.length) return [];
    return [`${label}:`, ...items.map((c) => `  - ${c.clause}: ${c.text}${c.tier === "guard" ? "" : tag}`)];
  };
  const body = [...clauseLines("Requires", card.preconditions), ...clauseLines("Ensures", card.postconditions), ...clauseLines("Invariants", card.invariants)];
  let effects = card.effects.length ? `Effects: ${card.effects.join(", ")}` : null;
  if (effects && n.kind === "Action") {
    const a = n as ActionNode;
    effects += `   (declared: ${a.effects.declared.join(", ") || "none"}${a.effects.verified.complete ? "" : ", unverified"})`;
  }
  const tail: string[] = [];
  if (effects) tail.push(effects);
  if (card.tests.length) tail.push(`Tests: ${card.tests.join(", ")}`);
  tail.push(`Owner: ${card.owner ?? "—"} · Last change: ${card.lastChange ?? "—"}`);
  const room = MAX_CARD_LINES - lines.length - tail.length;
  if (body.length > room) {
    const kept = body.slice(0, Math.max(0, room - 1));
    kept.push(`  … ${body.length - kept.length} more lines (inspect ${id})`);
    lines.push(...kept);
  } else lines.push(...body);
  lines.push(...tail);
  return `${lines.slice(0, MAX_CARD_LINES).join("\n")}\n`;
}

const CARD_KINDS = new Set(["Action", "Query", "Entity", "Policy", "Event", "Workflow", "Integration"]);

/** Write `.averri/cards/<encoded id>.md` for every declared node; remove cards of nodes that disappeared. */
export function writeCards(root: string, graph: Graph): string[] {
  const dir = cachePath(root, "cards");
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const keep = new Set<string>();
  for (const id of Object.keys(graph.nodes).sort(compareStrings) as NodeId[]) {
    const n = graph.nodes[id] as Node;
    if (!CARD_KINDS.has(n.kind) || n.provenance.origin === "extracted") continue;
    const md = renderCardMarkdown(graph, id);
    if (!md) continue;
    const name = `${nodeIdToFileName(id)}.md`;
    keep.add(name);
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== md) fs.writeFileSync(file, md);
    written.push(name);
  }
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".md") && !keep.has(f)) fs.unlinkSync(path.join(dir, f));
  return written;
}
