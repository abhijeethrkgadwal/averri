/**
 * The six static verifiers (SPEC-IR §3): route-match, effect-scan, emit-scan, zod-match,
 * consumer-scan, test-link. Each records whether it is applicable to a node and whether it passed;
 * `finalizeProvenance` upgrades a declared node to `verified` iff EVERY applicable verifier passed (D-9).
 */

import { Node } from "ts-morph";
import {
  collectEmittedEvents,
  type ActionNode,
  type EventId,
  type ExposureId,
  type EventNode,
  type Evidence,
  type ExposureNode,
  type IntegrationNode,
  type NodeId,
  type Provenance,
  type QueryNode,
  type TestNode,
  type VerifierId,
} from "@averri/ir";
import { routePathsMatch } from "@averri/extract";
import type { DeclFacts } from "../model.js";
import { addEdge, declaredProvenance, type BuildState } from "../state.js";
import { compareStrings } from "../util.js";
import { resolveFunction } from "../lower/declarations.js";
import { integrationClientMap, runParamNames, scanEffects, type ScanResult } from "./effect-scan.js";

export interface VerifierRecord {
  applicable: Set<VerifierId>;
  passed: Set<VerifierId>;
  evidence: Evidence[];
}

export interface VerifyOutput {
  records: Map<NodeId, VerifierRecord>;
  scans: Map<NodeId, ScanResult>;
}

const VERIFIER_ORDER: VerifierId[] = ["route-match", "effect-scan", "emit-scan", "zod-match", "consumer-scan", "test-link"];

function rec(out: VerifyOutput, id: NodeId): VerifierRecord {
  let r = out.records.get(id);
  if (!r) {
    r = { applicable: new Set(), passed: new Set(), evidence: [] };
    out.records.set(id, r);
  }
  return r;
}

function verifiedProvenance(declaredAt: Provenance, verifiers: VerifierId[], evidence: Evidence[]): Provenance {
  const at = declaredAt.origin === "extracted" ? null : declaredAt.declaredAt;
  if (!at) return declaredAt;
  return { origin: "verified", declaredAt: at, verifiers, evidence };
}

export function runVerifiers(state: BuildState): VerifyOutput {
  const out: VerifyOutput = { records: new Map(), scans: new Map() };
  routeMatch(state, out);
  webhookExposures(state);
  effectScan(state, out);
  consumerScan(state, out);
  testLink(state);
  return out;
}

// ---------------------------------------------------------------------------
// route-match
// ---------------------------------------------------------------------------

function exposures(state: BuildState): ExposureNode[] {
  return [...state.nodes.values()].filter((n): n is ExposureNode => n.kind === "Exposure").sort((a, b) => compareStrings(a.id, b.id));
}

function confidenceOf(n: ExposureNode): number {
  return n.provenance.origin === "extracted" ? n.provenance.confidence : 1;
}

/** Exposures matching a declared method + path (best first: confidence desc, then id). */
export function matchingExposures(state: BuildState, method: string, path: string): ExposureNode[] {
  return exposures(state)
    .filter((x) => x.method === method && routePathsMatch(path, x.path))
    .sort((a, b) => confidenceOf(b) - confidenceOf(a) || compareStrings(a.id, b.id));
}

function routeMatch(state: BuildState, out: VerifyOutput): void {
  for (const f of state.facts) {
    const n = state.nodes.get(f.nodeId);
    if (!n || (n.kind !== "Action" && n.kind !== "Query")) continue;
    const node = n as ActionNode | QueryNode;
    if (!node.route) continue;
    const r = rec(out, node.id);
    r.applicable.add("route-match");
    const match = matchingExposures(state, node.route.method, node.route.path)[0];
    if (!match) continue;
    node.route.exposure = match.id as ExposureId;
    node.route.verified = true;
    r.passed.add("route-match");
    const [line, col] = parseExposurePos(match.id);
    const ev: Evidence = { kind: "route", note: `${match.method} ${match.path} registered at ${match.src?.file ?? "?"}:${line}:${col}` };
    if (match.src) ev.src = match.src;
    r.evidence.push(ev);
    if (match.boundTo === null) match.boundTo = node.id as ExposureNode["boundTo"];
    if (node.public) match.public = true;
    addEdge(state, "exposes", match.id, node.id, { origin: "verified", declaredAt: node.src ?? match.src ?? { file: "", range: [[1, 0], [1, 0]] }, verifiers: ["route-match"], evidence: [ev] });
    if (node.policy) addEdge(state, "authorizes", node.policy, match.id, declaredProvenance(node.src as NonNullable<typeof node.src>));
  }
}

function parseExposurePos(id: string): [number, number] {
  const m = /:(\d+):(\d+)$/.exec(id);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/** Integration `webhook.exposure`: by declared route, else the Exposure whose handler reads the verify header. */
function webhookExposures(state: BuildState): void {
  for (const f of state.facts) {
    if (f.site.construct !== "integration") continue;
    const n = state.nodes.get(f.nodeId) as IntegrationNode | undefined;
    if (!n || !n.webhook) continue;
    let found: ExposureNode | undefined;
    if (f.webhookRoute) found = matchingExposures(state, f.webhookRoute.method, f.webhookRoute.path)[0];
    if (!found) {
      const header = n.webhook.verify.toLowerCase();
      for (const x of exposures(state)) {
        const text = registrationText(state, x);
        if (text && new RegExp(`["'\`]${escapeRe(header)}["'\`]`, "i").test(text)) {
          found = x;
          break;
        }
      }
    }
    if (found) n.webhook.exposure = found.id as ExposureId;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Source text of an Exposure's registration call (and of its handler when it is a named function). */
export function registrationText(state: BuildState, x: ExposureNode): string | null {
  const call = registrationCall(state, x);
  if (!call) return null;
  let text = call.getText();
  if (x.handler && x.handler.symbol !== "(anonymous)" && x.handler.range) {
    const t = state.text(x.handler.file);
    if (t) text += `\n${sliceRange(t, x.handler.range.range)}`;
  }
  return text;
}

function sliceRange(text: string, range: [[number, number], [number, number]]): string {
  const lines = text.split("\n");
  return lines.slice(range[0][0] - 1, range[1][0]).join("\n");
}

/** The `X.<method>(...)` registration call of an Exposure, located from its id's line:col. */
export function registrationCall(state: BuildState, x: ExposureNode): Node | null {
  const file = x.src?.file;
  if (!file) return null;
  const sf = state.ctx.sourceFile(file);
  if (!sf) return null;
  const [line, col] = parseExposurePos(x.id);
  let pos: number;
  try {
    pos = sf.compilerNode.getPositionOfLineAndCharacter(line - 1, col);
  } catch {
    return null;
  }
  let n: Node | undefined = sf.getDescendantAtPos(pos);
  while (n && !Node.isCallExpression(n)) n = n.getParent();
  return n ?? null;
}

// ---------------------------------------------------------------------------
// effect-scan + emit-scan
// ---------------------------------------------------------------------------

function effectScan(state: BuildState, out: VerifyOutput): void {
  const clients = integrationClientMap(state);
  for (const f of state.facts) {
    const n = state.nodes.get(f.nodeId);
    if (!n) continue;
    if (n.kind === "Action" || n.kind === "Query") scanDeclaration(state, out, f, n as ActionNode | QueryNode, clients);
    else if (n.kind === "Workflow" && f.runnerNode) {
      const scan = scanEffects(state, f.runnerNode, { integrationClients: clients });
      out.scans.set(n.id, scan);
      const prov: Provenance = { origin: "verified", declaredAt: n.src ?? (f.site.src), verifiers: ["effect-scan"], evidence: scan.evidence.slice(0, 5) };
      for (const w of [...scan.writes].sort()) addEdge(state, "writes", n.id, w, prov);
      for (const c of [...scan.calls].sort()) addEdge(state, "calls", n.id, c, prov);
    }
  }
  scanUndeclaredExposures(state, clients);
}

/**
 * SPEC-IR §3: a `reads`/`writes` edge inferred from a bare `prisma.x.<op>` call in an undeclared
 * handler is `extracted` (D-41f). Without these edges `impact Entity:X` omits every route that has not
 * been declared yet. Confidence is 0.8 (0.6 when the scan is incomplete), below the 0.9 assertion
 * threshold, so consumers see the `verify` hint rather than a stated fact.
 */
function scanUndeclaredExposures(state: BuildState, clients: ReturnType<typeof integrationClientMap>): void {
  for (const x of exposures(state)) {
    if (x.boundTo !== null) continue;
    const call = registrationCall(state, x);
    if (!call || !Node.isCallExpression(call)) continue;
    const handlerArg = call.getArguments().at(-1);
    if (!handlerArg) continue;
    const fn = resolveFunction(handlerArg);
    if (!fn) continue;
    let scan: ScanResult;
    try {
      scan = scanEffects(state, fn, { integrationClients: clients });
    } catch {
      continue;
    }
    const prov: Provenance = {
      origin: "extracted",
      extractor: "ts-handler",
      confidence: scan.complete ? 0.8 : 0.6,
      evidence: scan.evidence.length > 0 ? scan.evidence.slice(0, 3) : [{ kind: "source", note: "effect-scan of the undeclared handler" }],
    };
    for (const w of [...scan.writes].sort(compareStrings)) addEdge(state, "writes", x.id, w, prov);
    for (const rd of [...scan.reads].sort(compareStrings)) addEdge(state, "reads", x.id, rd, prov);
  }
}

function scanDeclaration(state: BuildState, out: VerifyOutput, f: DeclFacts, node: ActionNode | QueryNode, clients: ReturnType<typeof integrationClientMap>): void {
  const r = rec(out, node.id);
  const isAction = node.kind === "Action";
  let scan: ScanResult | null = null;
  if (f.body && f.bodyResolvable) {
    r.applicable.add("effect-scan");
    const names = node.mode === "declared" ? runParamNames(f.body) : { clientNames: [], emitNames: [], ctxNames: [] };
    const observeEventPrefix = node.mode === "observe" ? state.config.eventNamePrefix : null;
    scan = scanEffects(state, f.body, { ...names, integrationClients: clients, observeEventPrefix });
    out.scans.set(node.id, scan);
    const sorted = <T extends string>(s: Set<T>): T[] => [...s].sort(compareStrings);
    const verifiedProv: Provenance = { origin: "verified", declaredAt: node.src ?? f.site.src, verifiers: ["effect-scan"], evidence: scan.evidence.slice(0, 5) };
    if (isAction) {
      const a = node as ActionNode;
      a.effects.verified = {
        reads: sorted(scan.reads),
        writes: sorted(scan.writes),
        emits: sorted(scan.emits),
        calls: sorted(scan.calls),
        complete: scan.complete,
      };
      for (const w of a.effects.verified.writes) addEdge(state, "writes", a.id, w, verifiedProv);
      for (const e of a.effects.verified.emits) addEdge(state, "emits", a.id, e, verifiedProv);
    } else {
      const q = node as QueryNode;
      q.reads = sorted(scan.reads);
    }
    for (const rd of sorted(scan.reads)) addEdge(state, "reads", node.id, rd, verifiedProv);
    for (const c of sorted(scan.calls)) addEdge(state, "calls", node.id, c, verifiedProv);
    // An incomplete scan cannot confirm anything: the node stays declared (A4002 may still add effects).
    const effectsOk = !isAction || effectsAgree(node as ActionNode, scan);
    const queryOk = isAction || scan.writes.size === 0;
    if (scan.complete && effectsOk && queryOk) {
      r.passed.add("effect-scan");
      r.evidence.push(...scan.evidence.slice(0, 5));
    }
  }
  if (isAction) {
    const a = node as ActionNode;
    const emittedClauses = new Set<EventId>();
    for (const c of f.contracts) if (c.ast && c.phase === "ensures") for (const ev of collectEmittedEvents(c.ast)) emittedClauses.add(ev);
    if (a.effects.declared.includes("event:emit") || emittedClauses.size > 0) {
      r.applicable.add("emit-scan");
      if (scan && scan.complete && scan.unknownEmits.length === 0) {
        const allClaused = [...emittedClauses].every((ev) => scan?.emits.has(ev));
        const declaredMatches = a.effects.declared.includes("event:emit") === scan.emits.size > 0;
        if (allClaused && declaredMatches) r.passed.add("emit-scan");
      }
    }
  }
  if (f.input?.isZod) r.applicable.add("zod-match");
}

/** `declared` vs `V` per SPEC-IR §3.1 rule 6 (complete: equality; incomplete: V ⊆ declared). */
export function effectsAgree(a: ActionNode, scan: ScanResult): boolean {
  const v = verifiedEffects(scan);
  const declared = new Set(a.effects.declared);
  if (scan.complete) return v.size === declared.size && [...v].every((x) => declared.has(x));
  return [...v].every((x) => declared.has(x));
}

/** `V` of SPEC-IR §3.1 rule 6 (raw ops count as db:read/db:write). */
export function verifiedEffects(scan: ScanResult): Set<ActionNode["effects"]["declared"][number]> {
  const v = new Set<ActionNode["effects"]["declared"][number]>();
  if (scan.writes.size > 0 || scan.rawWrites) v.add("db:write");
  if (scan.reads.size > 0 || scan.rawReads) v.add("db:read");
  if (scan.emits.size > 0) v.add("event:emit");
  if (scan.calls.size > 0) v.add("network");
  return v;
}

// ---------------------------------------------------------------------------
// consumer-scan
// ---------------------------------------------------------------------------

function consumerScan(state: BuildState, out: VerifyOutput): void {
  const prefix = state.config.eventNamePrefix ?? "";
  for (const n of state.nodes.values()) {
    if (n.kind !== "Event") continue;
    const ev = n as EventNode;
    if (ev.external) continue;
    const r = rec(out, ev.id);
    r.applicable.add("consumer-scan");
    const wanted = `${prefix}${ev.name}`;
    const consumers = state.edges.filter((e) => e.kind === "consumedBy" && e.from === ev.id).map((e) => e.to);
    for (const wid of consumers) {
      const f = state.factsById.get(wid);
      const runner = f?.runnerNode;
      if (!runner) continue;
      let hit = false;
      const check = (node: Node): void => {
        node.forEachDescendant((d, t) => {
          if ((Node.isStringLiteral(d) || Node.isNoSubstitutionTemplateLiteral(d)) && d.getLiteralText() === wanted) {
            hit = true;
            t.stop();
          }
        });
      };
      if ((Node.isStringLiteral(runner) || Node.isNoSubstitutionTemplateLiteral(runner)) && runner.getLiteralText() === wanted) hit = true;
      else check(runner);
      if (hit) {
        r.passed.add("consumer-scan");
        r.evidence.push({ kind: "source", note: `${wid.slice("Workflow:".length)} runner registers "${wanted}" (${state.rel(runner.getSourceFile())}:${runner.getStartLineNumber()})` });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// test-link
// ---------------------------------------------------------------------------

const VERIFIED_BY_SOURCES = new Set(["Action", "Query", "Policy", "Contract", "Event", "Workflow", "Integration", "Exposure"]);

function testLink(state: BuildState): void {
  for (const n of [...state.nodes.values()]) {
    if (n.kind !== "Test") continue;
    const t = n as TestNode;
    if (t.generated) continue;
    const linked: TestNode["covers"] = [];
    for (const id of t.covers) {
      const target = state.nodes.get(id);
      if (!target || !VERIFIED_BY_SOURCES.has(target.kind)) continue;
      linked.push(id);
      const at = t.src ?? { file: t.file, range: [[1, 0], [1, 0]] as [[number, number], [number, number]] };
      addEdge(state, "verifiedBy", id, t.id, {
        origin: "verified",
        declaredAt: at,
        verifiers: ["test-link"],
        evidence: [{ kind: "test", note: `${t.file} covers ${id}` }],
      });
    }
    t.covers = Array.from(new Set(linked)).sort(compareStrings);
  }
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

/** Mark zod-match as passed for nodes the rules found no input drift on. */
export function passZodMatch(out: VerifyOutput, ids: Iterable<NodeId>): void {
  for (const id of ids) {
    const r = out.records.get(id);
    if (r && r.applicable.has("zod-match")) {
      r.passed.add("zod-match");
    }
  }
}

/** Upgrade declared nodes whose applicable verifiers all passed (D-9). */
export function finalizeProvenance(state: BuildState, out: VerifyOutput): void {
  for (const [id, r] of out.records) {
    const n = state.nodes.get(id);
    if (!n || n.provenance.origin !== "declared") continue;
    if (r.applicable.size === 0) continue;
    if (![...r.applicable].every((v) => r.passed.has(v))) continue;
    const verifiers = VERIFIER_ORDER.filter((v) => r.applicable.has(v));
    n.provenance = verifiedProvenance(n.provenance, verifiers, r.evidence.slice(0, 8));
  }
}

