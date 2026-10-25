/**
 * `check` (SPEC-MCP §6.5, ARCHITECTURE §3.4): build (regenerating stale generated tests) → tsc
 * (cascade-collapsed, A9001) → Vitest on the affected tests (A9002) → merge into diagnostics →
 * `.averri/last-check.json`; when green, `.averri/last-green.json` + the pinned snapshot.
 *
 * Affected scope: dirty tree → HEAD vs working tree; clean tree → last-green..HEAD; `diffBase` → that
 * ref; no base at all → `all`. The affected set is never silently empty (D-34).
 */

import { type ContractId, type Diagnostic, type Graph, type NodeId, type PolicyId, type TestId, type TestNode } from "@averri/ir";
import { build } from "../build.js";
import {
  acquireBuildLock,
  readCachedGraph,
  readLastGreenGraph,
  writeCachedGraph,
  writeLastCheck,
  writeLastGreen,
  writeSnapshot,
  type TestRunRecord,
} from "../cache.js";
import { emit, finalizeDiagnostics } from "../diagnostics.js";
import { testFilesReaching } from "./imports.js";
import { gitChangedFiles, gitDiff, gitInfo } from "../git.js";
import { impactOfGraphs, type ImpactResult } from "../impact.js";
import { isFresh } from "../load.js";
import { buildAtRef } from "../revisions.js";
import { tracesForTest } from "../traces.js";
import { compareStrings } from "../util.js";
import { BUDGETS, capMore, responseTokens } from "../query/budget.js";
import { collapseTscErrors, diffSymbols } from "./tsc-collapse.js";
import { runTsc, type TscError } from "./tsc.js";
import { contractOf, rerunCommand, runVitest, testIdOf, type VitestAssertion, type VitestRunner } from "./vitest.js";

export interface CheckOptions {
  scope?: "affected" | "all";
  diffBase?: string;
  acknowledgeWeakening?: boolean;
  /** Injected for tests; default runs the TypeScript compiler. `false` skips tsc. */
  tsc?: ((root: string) => TscError[]) | false;
  /** Injected for tests; default spawns `npx vitest run --reporter=json`. `false` skips tests. */
  vitest?: VitestRunner | false;
  /** Base graph override (tests); otherwise derived from git / last green. */
  baseGraph?: Graph | null;
  now?: () => Date;
  git?: boolean;
}

export interface CheckFailure {
  testId: TestId;
  contract?: ContractId;
  title: string;
  file: string;
  traceId?: string;
  rerun: string;
}

export interface CheckData {
  diagnostics: Diagnostic[];
  tests: { ran: number; passed: number; failed: number; skipped: number; failures: CheckFailure[] };
  coverage: { generated: number; handWritten: number; message: string; tests: Array<{ id: TestId; suite: string; file: string; generated: boolean }> };
  contractsWeakened: ImpactResult["contractsWeakened"];
  policiesRemoved: PolicyId[];
  green: boolean;
}

export interface CheckResult {
  data: CheckData;
  graph: Graph;
  truncated: boolean;
  more?: string[];
  /** How the affected set was chosen. */
  base: { kind: "diffBase" | "head" | "last-green" | "none"; ref: string | null };
}

async function freshGraphWithTests(root: string, options: CheckOptions): Promise<Graph> {
  const cached = readCachedGraph(root);
  if (isFresh(root, cached, {}) && cached.meta.health.staleGeneratedTests === 0) return cached;
  const lock = await acquireBuildLock(root);
  try {
    return build(root, { writeTests: true, writeCache: true, ...(options.now ? { now: options.now } : {}), ...(options.git === false ? { git: false } : {}), previous: cached }).graph;
  } finally {
    lock.release();
  }
}

function baseFor(root: string, options: CheckOptions): { graph: Graph | null; kind: CheckResult["base"]["kind"]; ref: string | null; diffText: string | null } {
  if (options.baseGraph !== undefined) return { graph: options.baseGraph, kind: options.baseGraph ? "diffBase" : "none", ref: null, diffText: null };
  const useGit = options.git !== false;
  const info = useGit ? gitInfo(root) : { commit: null, dirty: false };
  if (options.diffBase && info.commit) {
    const g = buildAtRef(root, options.diffBase);
    if (g) return { graph: g, kind: "diffBase", ref: options.diffBase, diffText: gitDiff(root, options.diffBase) };
  }
  if (info.commit && info.dirty) {
    const g = buildAtRef(root, "HEAD");
    if (g) return { graph: g, kind: "head", ref: "HEAD", diffText: gitDiff(root, "HEAD") };
  }
  const lg = readLastGreenGraph(root);
  if (lg) return { graph: lg, kind: "last-green", ref: lg.meta.commit, diffText: lg.meta.commit && useGit ? gitDiff(root, lg.meta.commit) : null };
  return { graph: null, kind: "none", ref: null, diffText: null };
}

function testNodes(graph: Graph): TestNode[] {
  return Object.values(graph.nodes)
    .filter((n): n is TestNode => n.kind === "Test")
    .sort((a, b) => compareStrings(a.id, b.id));
}

export async function check(root: string, options: CheckOptions = {}): Promise<CheckResult> {
  const now = options.now ?? (() => new Date());
  let graph = await freshGraphWithTests(root, options);
  const base = baseFor(root, options);
  const scope = options.scope ?? "affected";
  const impact = base.graph ? impactOfGraphs(base.graph, graph) : null;

  // --- which tests ---
  const all = testNodes(graph);
  let selected: TestNode[];
  let coverageMessage: string;
  if (scope === "all" || !impact) {
    selected = all;
    coverageMessage = scope === "all" ? `scope all: ${all.length} tests` : "no base to diff against (no git change and no last green): running all tests";
  } else {
    const ids = new Set<string>(impact.testsToRun.map((t) => t.id));
    const changedFiles = new Set(options.git === false ? [] : gitChangedFiles(root, base.kind === "last-green" && base.ref ? base.ref : options.diffBase ?? "HEAD"));
    for (const t of all) if (changedFiles.has(t.file)) ids.add(t.id);
    // Hand-written tests: those whose import closure reaches a changed file (D-41e). Changed files are
    // the git-changed paths plus every Module the graph diff reports as changed.
    for (const id of impact.changed) {
      const n = graph.nodes[id];
      if (n?.kind === "Module") changedFiles.add(n.file);
    }
    const handWritten = all.filter((t) => !t.generated);
    const handWrittenFiles = Array.from(new Set(handWritten.map((t) => t.file))).sort(compareStrings);
    const reaching = new Set(testFilesReaching(root, handWrittenFiles, changedFiles));
    for (const t of handWritten) if (reaching.has(t.file)) ids.add(t.id);
    selected = all.filter((t) => ids.has(t.id));
    const skippedHand = handWritten.filter((t) => !ids.has(t.id));
    const skippedNote = skippedHand.length > 0 ? `; ${skippedHand.length} hand-written tests in ${new Set(skippedHand.map((t) => t.file)).size} files were not selected (no import path to a changed file)` : "";
    if (selected.length === 0) {
      selected = all.filter((t) => t.generated);
      coverageMessage = `the change affects no test; running all ${selected.length} generated tests instead${skippedNote}`;
    } else {
      const gen = selected.filter((t) => t.generated).length;
      coverageMessage = `${gen} generated + ${selected.length - gen} hand-written tests cover your change${skippedNote}`;
    }
  }

  // --- tsc ---
  const diagnostics: Diagnostic[] = [...graph.diagnostics];
  if (options.tsc !== false) {
    const errors = (options.tsc ?? runTsc)(root);
    const symbols = diffSymbols(base.diffText, graph, impact?.diff ?? null);
    diagnostics.push(...collapseTscErrors(errors, { graph, symbols }));
  }

  // --- vitest ---
  const runs: TestRunRecord[] = [];
  const failures: CheckFailure[] = [];
  let ran = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  if (options.vitest !== false && selected.length > 0) {
    const files = Array.from(new Set(selected.map((t) => t.file))).sort(compareStrings);
    const report = (options.vitest ?? runVitest)(root, files);
    if (report.error && report.assertions.length === 0) {
      diagnostics.push(emit("A9002", { node: null, src: null, title: "Vitest did not produce a report", message: report.error.slice(0, 600), cause: [] }));
      failed++;
    }
    const selectedIds = new Set(selected.map((t) => t.id));
    for (const a of report.assertions) {
      const testId = testIdOf(graph, a);
      if (!selectedIds.has(testId) && !files.includes(a.file)) continue;
      ran++;
      if (a.status === "passed") passed++;
      else if (a.status === "failed") failed++;
      else skipped++;
      const rec: TestRunRecord = { id: testId, title: a.title, file: a.file, status: a.status };
      const contract = contractOf(a);
      if (a.status === "failed") {
        if (contract) rec.failedContracts = [contract];
        rec.message = (a.failureMessages[0] ?? "").split("\n")[0]?.slice(0, 300) ?? "";
        const trace = tracesForTest(root, { file: a.file, title: a.title }).pop();
        if (trace) rec.traceId = trace.traceId;
        const failure: CheckFailure = { testId, title: a.title, file: a.file, rerun: rerunCommand(a) };
        if (contract) failure.contract = contract;
        if (trace) failure.traceId = trace.traceId;
        failures.push(failure);
        diagnostics.push(failureDiagnostic(graph, a, testId, contract, rec.message));
      }
      runs.push(rec);
    }
    graph = withLastResults(graph, runs, now().toISOString());
    writeCachedGraph(root, graph);
  }

  // --- merge ---
  const finalDiags = finalizeDiagnostics(diagnostics, { nodes: graph.nodes });
  const contractsWeakened = impact?.contractsWeakened ?? [];
  const policiesRemoved = impact?.policiesRemoved ?? [];
  const hasErrors = finalDiags.some((d) => d.severity === "error");
  const green = !hasErrors && failed === 0 && (options.acknowledgeWeakening === true || (contractsWeakened.length === 0 && policiesRemoved.length === 0));
  const coverageTests = selected.map((t) => ({ id: t.id as TestId, suite: t.suite, file: t.file, generated: t.generated }));
  const data: CheckData = {
    diagnostics: finalDiags,
    tests: { ran, passed, failed, skipped, failures },
    coverage: {
      generated: selected.filter((t) => t.generated).length,
      handWritten: selected.filter((t) => !t.generated).length,
      message: coverageMessage,
      tests: coverageTests,
    },
    contractsWeakened,
    policiesRemoved,
    green,
  };
  writeLastCheck(root, { meta: { contentHash: graph.meta.contentHash, at: now().toISOString() }, diagnostics: finalDiags, tests: runs });
  if (green) {
    const snapshot = writeSnapshot(root, graph);
    writeLastGreen(root, { meta: graph.meta, tests: runs, at: now().toISOString(), snapshot });
  }
  const bounded = boundCheck(data);
  return { data: bounded.data, graph, truncated: bounded.truncated, ...(bounded.more.length ? { more: bounded.more } : {}), base: { kind: base.kind, ref: base.ref } };
}

/**
 * Budget (SPEC-MCP §6.5, D-41d): measured over the whole response (envelope fields, `more`, `data`).
 * Drop order: coverage.tests beyond 20; repeated diagnostics of one code and title collapse into the
 * first one (the rest are named in `more`); coverage.tests from the end; diagnostics from the end
 * (errors sort first, so warnings go first); failures from the end. `more` lists actionable handles
 * first (failures, diagnostic nodes) and test ids last, and is itself capped by `capMore`.
 */
export function boundCheck(input: CheckData): { data: CheckData; truncated: boolean; more: string[] } {
  const data: CheckData = {
    ...input,
    diagnostics: [...input.diagnostics],
    coverage: { ...input.coverage, tests: [...input.coverage.tests] },
    tests: { ...input.tests, failures: [...input.tests.failures] },
  };
  const moreFailures: string[] = [];
  const moreDiagnostics: string[] = [];
  const moreTests: string[] = [];
  const moreAll = (): string[] => [...moreFailures, ...moreDiagnostics, ...moreTests];
  const over = (): boolean => responseTokens(data, moreAll()) > BUDGETS.check;
  let truncated = false;
  while (data.coverage.tests.length > 20) {
    moreTests.unshift((data.coverage.tests.pop() as { id: string }).id);
    truncated = true;
  }
  if (over()) {
    const collapsed = collapseRepeated(data.diagnostics);
    if (collapsed.dropped.length > 0) {
      data.diagnostics = collapsed.kept;
      moreDiagnostics.push(...collapsed.dropped);
      truncated = true;
    }
  }
  while (over() && data.coverage.tests.length > 0) {
    moreTests.unshift((data.coverage.tests.pop() as { id: string }).id);
    truncated = true;
  }
  while (over() && data.diagnostics.length > 1) {
    const d = data.diagnostics.pop() as Diagnostic;
    moreDiagnostics.push(d.node ?? d.id);
    truncated = true;
  }
  while (over() && data.tests.failures.length > 1) {
    moreFailures.push((data.tests.failures.pop() as CheckFailure).testId);
    truncated = true;
  }
  return { data, truncated, more: capMore(moreAll()) };
}

/**
 * Keeps the first diagnostic of every (code, title) group and returns the node (or diagnostic) ids of
 * the others. The kept entry says how many it stands for.
 */
function collapseRepeated(diagnostics: readonly Diagnostic[]): { kept: Diagnostic[]; dropped: string[] } {
  const keyOf = (d: Diagnostic): string => `${d.code}\u0000${d.title}`;
  const groups = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) groups.set(keyOf(d), [...(groups.get(keyOf(d)) ?? []), d]);
  const kept: Diagnostic[] = [];
  const dropped: string[] = [];
  for (const d of diagnostics) {
    const group = groups.get(keyOf(d)) as Diagnostic[];
    if (group[0] !== d) continue;
    if (group.length === 1) {
      kept.push(d);
      continue;
    }
    const rest = group.slice(1);
    dropped.push(...rest.map((r) => r.node ?? r.id));
    const note = `+${rest.length} more with the same code and title (their nodes are in \`more\`)`;
    kept.push({ ...d, message: d.message ? `${d.message} ${note}` : note });
  }
  return { kept, dropped };
}

function failureDiagnostic(graph: Graph, a: VitestAssertion, testId: TestId, contract: ContractId | undefined, message: string): Diagnostic {
  const test = graph.nodes[testId] as TestNode | undefined;
  // Prefer the Test node, then the contract, then the test file's Module, then the owner named by a
  // generated file (`<generatedDir>/<owner>.gen.test.ts`).
  const ownerFromFile = /([^/]+)\.gen\.test\.ts$/.exec(a.file)?.[1];
  const owner = ownerFromFile ? (Object.keys(graph.nodes) as NodeId[]).find((id) => id.slice(id.indexOf(":") + 1) === ownerFromFile) : undefined;
  const node: NodeId | null = test
    ? testId
    : contract && graph.nodes[contract]
      ? contract
      : graph.nodes[`Module:${a.file}` as NodeId]
        ? (`Module:${a.file}` as NodeId)
        : (owner ?? null);
  const cause = [];
  if (contract && graph.nodes[contract]) cause.push({ node: contract as NodeId, why: "the assertion for this contract failed" });
  if (test) cause.push({ node: testId as NodeId, why: `${a.file}: ${a.title.slice(0, 100)}` });
  return emit("A9002", {
    node,
    src: { file: a.file, range: [[a.line ?? 1, 0], [a.line ?? 1, 0]] },
    title: `Test failed: ${(a.title.split(" > ").pop() ?? a.title).replace(/\[[^\]]+\]\s*/g, "")}`.slice(0, 80),
    message: message || undefined,
    cause,
    related: test ? test.covers.slice(0, 5) : [],
  });
}

/** Copy of the graph with `lastResult` set on the Test nodes that ran (check writes it, build never does). */
export function withLastResults(graph: Graph, runs: readonly TestRunRecord[], at: string): Graph {
  const byId = new Map<string, TestRunRecord[]>();
  for (const r of runs) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const nodes = { ...graph.nodes };
  for (const [id, rs] of byId) {
    const n = nodes[id as NodeId];
    if (!n || n.kind !== "Test") continue;
    const status = rs.some((r) => r.status === "failed") ? "failed" : rs.every((r) => r.status === "skipped") ? "skipped" : rs.every((r) => r.status === "passed" || r.status === "skipped") ? "passed" : "unknown";
    const failedContracts = Array.from(new Set(rs.flatMap((r) => r.failedContracts ?? []))).sort(compareStrings) as ContractId[];
    nodes[id as NodeId] = { ...(n as TestNode), lastResult: failedContracts.length ? { status, at, failedContracts } : { status, at } };
  }
  return { ...graph, nodes };
}
