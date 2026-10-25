/**
 * `explain` (SPEC-MCP §6.6): why a test, diagnostic or trace failed — actual vs expected, the
 * pasteable triggering input, the exposure → route → policy → contract → handler → event → workflow →
 * test chain, the graph ops since the last green build that touch the chain, and the declaration's
 * author. No hypotheses, no fixes. <= 1 500 tokens.
 */

import {
  diffGraphs,
  opsTouching,
  type ActionNode,
  type ContractNode,
  type Diagnostic,
  type Graph,
  type GraphDiffOp,
  type HttpMethod,
  type Node,
  type NodeId,
  type QueryNode,
  type TestNode,
  type WorkflowNode,
} from "@averri/ir";
import { readLastCheck, readLastGreenGraph } from "./cache.js";
import { readConfig } from "./config.js";
import { gitBlameAuthor } from "./git.js";
import { resolveNodeId, verifyNote } from "./impact.js";
import { BUDGETS, responseTokens, type QueryResult } from "./query/budget.js";
import { renderClause } from "./render.js";
import { findTrace, tracesForTest, type TracePhaseRecord, type TraceRecord } from "./traces.js";
import { rerunCommand } from "./check/vitest.js";
import { compareStrings } from "./util.js";

export interface ExplainInput {
  testId?: string;
  diagId?: string;
  diag?: { code: string; node: string };
  traceId?: string;
  detail?: "summary" | "full";
}

export type ChainRole = "exposure" | "route" | "policy" | "contract" | "handler" | "event" | "workflow" | "test";

export interface ExplainData {
  subject: { kind: "test" | "diagnostic" | "trace"; id: string };
  failure: { assertion: string; actual: unknown; expected: unknown } | null;
  triggeringInput: { method?: HttpMethod; path?: string; body?: unknown; actor?: { fixture: string; id: string | null } } | null;
  rerun?: string;
  chain: Array<{ node: NodeId; role: ChainRole; note: string; path: string | null; verify?: string }>;
  sinceLastGreen: GraphDiffOp[];
  declaration: { contract: string; path: string; author: string | null } | null;
  trace?: TraceRecord;
  stack?: string;
}

export interface ExplainOptions {
  root?: string;
  /** Last-green graph override (tests). */
  lastGreen?: Graph | null;
  /** Disable git blame (tests). */
  blame?: boolean;
}

function pathOf(n: Node | undefined): string | null {
  return n?.src ? `${n.src.file}:${n.src.range[0][0]}` : null;
}

function link(graph: Graph, id: NodeId, role: ChainRole, note: string): ExplainData["chain"][number] {
  const n = graph.nodes[id];
  const entry: ExplainData["chain"][number] = { node: id, role, note, path: pathOf(n) };
  const v = verifyNote(n);
  if (v) entry.verify = v;
  return entry;
}

/** The declaration chain around an Action/Query, optionally focused on one contract. */
export function chainFor(graph: Graph, owner: NodeId, contract: NodeId | null, testId: NodeId | null): ExplainData["chain"] {
  const chain: ExplainData["chain"] = [];
  const decl = graph.nodes[owner] as ActionNode | QueryNode | undefined;
  if (decl && (decl.kind === "Action" || decl.kind === "Query")) {
    if (decl.route?.exposure && graph.nodes[decl.route.exposure]) {
      const x = graph.nodes[decl.route.exposure] as Node & { method: string; path: string };
      chain.push(link(graph, decl.route.exposure, "exposure", `registers ${x.method} ${x.path}`));
    }
    chain.push(link(graph, owner, "route", decl.route ? `declares ${decl.route.method} ${decl.route.path} (${decl.mode})` : `${decl.mode} ${decl.kind.toLowerCase()} without route`));
    if (decl.policy) {
      const p = graph.nodes[decl.policy];
      const allow = p && p.kind === "Policy" ? (graph.nodes[p.allow] as ContractNode | undefined) : undefined;
      chain.push(link(graph, decl.policy, "policy", allow?.expr ? renderClause(allow.expr) : "opaque guard"));
    }
  } else if (graph.nodes[owner]) {
    chain.push(link(graph, owner, "route", `${graph.nodes[owner]?.kind} ${graph.nodes[owner]?.name}`));
  }
  if (contract && graph.nodes[contract]?.kind === "Contract") {
    const c = graph.nodes[contract] as ContractNode;
    chain.push(link(graph, contract, "contract", `${c.phase} ${c.clause}: ${c.expr ? renderClause(c.expr) : "opaque guard"}`));
  }
  if (decl && (decl.kind === "Action" || decl.kind === "Query") && decl.handler) {
    chain.push({ node: owner, role: "handler", note: `${decl.handler.symbol} in ${decl.handler.file}`, path: decl.handler.range ? `${decl.handler.file}:${decl.handler.range.range[0][0]}` : decl.handler.file ? `${decl.handler.file}:1` : null });
  }
  for (const e of graph.edges.filter((x) => x.kind === "emits" && x.from === owner).sort((a, b) => compareStrings(a.to, b.to))) {
    chain.push(link(graph, e.to, "event", `emits ${e.to.slice(6)}`));
    for (const w of graph.edges.filter((x) => x.kind === "consumedBy" && x.from === e.to)) {
      const wf = graph.nodes[w.to] as WorkflowNode | undefined;
      chain.push(link(graph, w.to, "workflow", `consumes ${e.to.slice(6)}${wf ? ` (${wf.engine})` : ""}`));
    }
  }
  if (testId && graph.nodes[testId]) {
    const t = graph.nodes[testId] as TestNode;
    chain.push(link(graph, testId, "test", `${t.generated ? "generated" : "hand-written"} ${t.suite} in ${t.file}`));
  }
  return chain;
}

function failingPhase(trace: TraceRecord): TracePhaseRecord | null {
  if (trace.outcome.ok) return null;
  const phase = trace.outcome.phase;
  const contract = trace.outcome.contract;
  return (
    trace.phases.find((p) => !p.ok && p.phase === phase && (!contract || !("contract" in p) || p.contract === contract)) ??
    trace.phases.find((p) => !p.ok) ??
    null
  );
}

function failureOf(graph: Graph, trace: TraceRecord): ExplainData["failure"] {
  if (trace.outcome.ok) {
    const disagree = trace.phases.find((p) => p.phase === "authorize" && !p.ok);
    if (!disagree) return null;
  }
  const rec = failingPhase(trace);
  if (!rec) return trace.outcome.ok ? null : { assertion: trace.outcome.message, actual: trace.outcome.phase, expected: "ok" };
  switch (rec.phase) {
    case "requires":
    case "ensures": {
      const c = graph.nodes[rec.contract as NodeId] as ContractNode | undefined;
      const evaluated = rec.evaluated ?? {};
      const lhs = Object.fromEntries(Object.entries(evaluated).map(([k, v]) => [k || "(root)", v.lhs]));
      const rhs = Object.fromEntries(Object.entries(evaluated).map(([k, v]) => [k || "(root)", v.rhs]));
      return {
        assertion: `${rec.contract}${c?.expr ? `: ${renderClause(c.expr)}` : c ? " (opaque guard)" : ""}`,
        actual: rec.undefinedRefs?.length ? { values: lhs, undefinedRefs: rec.undefinedRefs } : lhs,
        expected: Object.keys(rhs).length ? rhs : c?.expr ? renderClause(c.expr) : true,
      };
    }
    case "authorize":
      return { assertion: `authorize${rec.policy ? ` (${rec.policy})` : ""}${rec.observed ? " — app decision vs declared policy" : ""}`, actual: rec.decision, expected: rec.observed ? "agreement with the declared policy" : "allow" };
    case "validate":
      return { assertion: "input validates against the declared Zod schema", actual: rec.issues ?? [], expected: "no issues" };
    case "run":
      return { assertion: "handler completes", actual: rec.error ?? "threw", expected: "no exception" };
    case "emit":
      return { assertion: "buffered events are published after commit", actual: rec.error ?? "emit failed", expected: rec.events.map((e) => e.event) };
  }
}

function triggering(root: string | null, trace: TraceRecord): ExplainData["triggeringInput"] {
  const out: NonNullable<ExplainData["triggeringInput"]> = {};
  if (trace.request) {
    out.method = trace.request.method;
    out.path = trace.request.path;
    out.body = trace.request.body;
  }
  if (root !== null) {
    const ids = readConfig(root).config.actorIds;
    const actorId = trace.actor?.id ?? null;
    const fixture = Object.entries(ids).find(([, id]) => id === actorId)?.[0] ?? (actorId === null ? "anonymous" : "unknown");
    out.actor = { fixture, id: actorId };
  }
  return Object.keys(out).length ? out : null;
}

function since(graph: Graph, lastGreen: Graph | null, chain: ExplainData["chain"]): GraphDiffOp[] {
  if (!lastGreen) return [];
  return opsTouching(diffGraphs(lastGreen, graph), chain.map((c) => c.node)).slice(0, 10);
}

function declarationOf(graph: Graph, root: string | null, contract: string | undefined, blame: boolean): ExplainData["declaration"] {
  if (!contract) return null;
  const c = graph.nodes[contract as NodeId];
  if (!c?.src) return null;
  return { contract, path: `${c.src.file}:${c.src.range[0][0]}`, author: root && blame ? gitBlameAuthor(root, c.src.file, c.src.range[0][0]) : null };
}

function fromTrace(graph: Graph, root: string | null, trace: TraceRecord, subject: ExplainData["subject"], options: ExplainOptions, testId: NodeId | null, detail: "summary" | "full"): ExplainData {
  const contract = trace.outcome.ok ? undefined : trace.outcome.contract;
  const owner = trace.action as NodeId;
  const chain = chainFor(graph, owner, contract && contract.startsWith("Contract:") ? (contract as NodeId) : null, testId);
  const lastGreen = options.lastGreen !== undefined ? options.lastGreen : root ? readLastGreenGraph(root) : null;
  const data: ExplainData = {
    subject,
    failure: failureOf(graph, trace),
    triggeringInput: triggering(root, trace),
    chain,
    sinceLastGreen: since(graph, lastGreen, chain),
    declaration: declarationOf(graph, root, contract?.startsWith("Contract:") ? contract : undefined, options.blame !== false),
  };
  if (trace.test) data.rerun = rerunCommand({ file: trace.test.file, title: trace.test.title });
  if (detail === "full") data.trace = trace;
  return data;
}

function bound(data: ExplainData): { data: ExplainData; truncated: boolean } {
  let truncated = false;
  const over = (): boolean => responseTokens(data) > BUDGETS.explain;
  if (over() && data.trace) {
    delete data.trace;
    truncated = true;
  }
  if (over() && data.stack) {
    data.stack = data.stack.split("\n").slice(0, 8).join("\n");
    truncated = true;
  }
  while (over() && data.sinceLastGreen.length > 0) {
    data.sinceLastGreen.pop();
    truncated = true;
  }
  if (over() && data.triggeringInput?.body !== undefined) {
    data.triggeringInput.body = "(omitted: see trace)";
    truncated = true;
  }
  while (over() && data.chain.length > 2) {
    data.chain.pop();
    truncated = true;
  }
  return { data, truncated };
}

export function explain(graph: Graph, input: ExplainInput, options: ExplainOptions = {}): QueryResult<ExplainData> {
  const root = options.root ?? graph.meta.root;
  const detail = input.detail ?? "summary";
  const given = [input.testId, input.diagId, input.diag, input.traceId].filter((x) => x !== undefined).length;
  if (given !== 1) return { ok: false, error: "bad-input", message: "exactly one of testId, diagId, diag, traceId is required" };

  if (input.traceId) {
    const trace = findTrace(root, input.traceId);
    if (!trace) return { ok: false, error: "not-found", message: `no trace ${input.traceId} in .averri/traces` };
    const testId = trace.test ? testFromTitle(graph, trace.test) : null;
    return { ok: true, ...bound(fromTrace(graph, root, trace, { kind: "trace", id: trace.traceId }, options, testId, detail)) };
  }

  if (input.testId) {
    const r = resolveNodeId(graph, input.testId);
    if (!r.ok || graph.nodes[r.id]?.kind !== "Test") return { ok: false, error: r.ok ? "not-found" : r.error, message: `no test ${input.testId}`, candidates: r.ok ? [] : r.candidates };
    const t = graph.nodes[r.id] as TestNode;
    const last = readLastCheck(root);
    const rec = last?.tests.find((x) => x.id === t.id && x.status === "failed") ?? last?.tests.find((x) => x.id === t.id);
    const traces = tracesForTest(root, { file: t.file, ...(rec ? { title: rec.title } : {}), id: t.id });
    const failingTrace = [...traces].reverse().find((x) => !x.outcome.ok || x.phases.some((p) => !p.ok)) ?? traces[traces.length - 1];
    if (failingTrace) {
      const data = fromTrace(graph, root, failingTrace, { kind: "test", id: t.id }, options, t.id, detail);
      if (rec?.message && data.failure === null) data.failure = { assertion: rec.title, actual: rec.message, expected: "assertion holds" };
      if (rec) data.rerun = rerunCommand({ file: rec.file, title: rec.title });
      if (detail === "full" && rec?.message) data.stack = rec.message;
      return { ok: true, ...bound(data) };
    }
    const owner = (t.covers.find((c) => c.startsWith("Action:") || c.startsWith("Query:")) ?? t.covers[0] ?? null) as NodeId | null;
    const contract = rec?.failedContracts?.[0] ?? (t.covers.find((c) => c.startsWith("Contract:")) as string | undefined);
    const chain = owner ? chainFor(graph, owner, contract ? (contract as NodeId) : null, t.id) : [link(graph, t.id, "test", `${t.suite} in ${t.file}`)];
    const lastGreen = options.lastGreen !== undefined ? options.lastGreen : readLastGreenGraph(root);
    const data: ExplainData = {
      subject: { kind: "test", id: t.id },
      failure: rec && rec.status === "failed" ? { assertion: rec.title, actual: rec.message ?? "failed", expected: "assertion holds" } : null,
      triggeringInput: null,
      chain,
      sinceLastGreen: since(graph, lastGreen, chain),
      declaration: declarationOf(graph, root, contract, options.blame !== false),
    };
    if (rec) data.rerun = rerunCommand({ file: rec.file, title: rec.title });
    return { ok: true, ...bound(data) };
  }

  let diag: Diagnostic | undefined;
  if (input.diagId) {
    const last = readLastCheck(root);
    if (!last) return { ok: false, error: "not-found", message: "no .averri/last-check.json; run check first" };
    if (last.meta.contentHash !== graph.meta.contentHash) {
      return { ok: false, error: "not-found", message: `diagnostics were from build ${last.meta.contentHash.slice(0, 12)}; run check again` };
    }
    diag = last.diagnostics.find((d) => d.id === input.diagId);
    if (!diag) return { ok: false, error: "not-found", message: `no diagnostic ${input.diagId} in the last check` };
  } else if (input.diag) {
    const { code, node } = input.diag;
    const r = resolveNodeId(graph, node);
    const id = r.ok ? r.id : (node as NodeId);
    diag = graph.diagnostics.find((d) => d.code === code && d.node === id) ?? readLastCheck(root)?.diagnostics.find((d) => d.code === code && d.node === id);
    if (!diag) return { ok: false, error: "not-found", message: `no ${code} diagnostic on ${node}` };
  }
  const d = diag as Diagnostic;
  const ids = [...d.cause.map((c) => c.node), ...(d.node ? [d.node] : [])];
  const owner = ids.find((id) => id.startsWith("Action:") || id.startsWith("Query:")) ?? ownerOf(graph, d.node);
  const contract = ids.find((id) => id.startsWith("Contract:")) ?? null;
  const chain: ExplainData["chain"] = owner ? chainFor(graph, owner, contract, null) : [];
  for (const c of d.cause) if (!chain.some((x) => x.node === c.node) && graph.nodes[c.node]) chain.push(link(graph, c.node, roleOf(graph.nodes[c.node] as Node), c.why));
  const lastGreen = options.lastGreen !== undefined ? options.lastGreen : readLastGreenGraph(root);
  const data: ExplainData = {
    subject: { kind: "diagnostic", id: d.id },
    failure: { assertion: d.title, actual: d.message ?? d.cause[0]?.why ?? null, expected: d.fixes[0] ? `${d.fixes[0].label} (${d.fixes[0].evidence})` : null },
    triggeringInput: null,
    chain,
    sinceLastGreen: since(graph, lastGreen, chain),
    declaration: declarationOf(graph, root, contract ?? undefined, options.blame !== false),
  };
  return { ok: true, ...bound(data) };
}

function ownerOf(graph: Graph, id: NodeId | null): NodeId | null {
  if (!id) return null;
  const n = graph.nodes[id];
  if (n?.kind === "Contract") return (n as ContractNode).of;
  if (n?.kind === "Exposure") return ((n as Node & { boundTo: NodeId | null }).boundTo ?? null) as NodeId | null;
  return n && (n.kind === "Action" || n.kind === "Query") ? id : null;
}

function roleOf(n: Node): ChainRole {
  switch (n.kind) {
    case "Exposure":
      return "exposure";
    case "Policy":
      return "policy";
    case "Contract":
      return "contract";
    case "Event":
      return "event";
    case "Workflow":
      return "workflow";
    case "Test":
      return "test";
    default:
      return "route";
  }
}

function testFromTitle(graph: Graph, test: { file: string; title: string }): NodeId | null {
  const m = /\[(Test:gen\/[^\]\s]+)\]/.exec(test.title);
  if (m && graph.nodes[m[1] as NodeId]) return m[1] as NodeId;
  for (const n of Object.values(graph.nodes)) {
    if (n.kind === "Test" && !(n as TestNode).generated && (n as TestNode).file === test.file && test.title.endsWith((n as TestNode).title.split(" > ").pop() ?? "\u0000")) return n.id;
  }
  return null;
}
