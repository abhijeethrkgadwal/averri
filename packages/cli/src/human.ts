/** Human renderings (picocolors). Machine output is the tool JSON; nothing here is parsed by anyone. */

import type { CheckData, ExplainData, FindHit, ImpactResult, InspectData, OverviewData } from "@averri/compiler";
import type { Diagnostic } from "@averri/ir";
import pc from "picocolors";
import type { ToolError } from "@averri/mcp";

export type Colors = ReturnType<typeof pc.createColors>;

export function colors(enabled: boolean): Colors {
  return pc.createColors(enabled);
}

const sevColor = (c: Colors, s: Diagnostic["severity"]): ((x: string) => string) => (s === "error" ? c.red : s === "warning" ? c.yellow : c.cyan);

export function renderDiagnostic(c: Colors, d: Diagnostic): string {
  const lines = [`${sevColor(c, d.severity)(c.bold(d.severity.padEnd(7)))} ${c.bold(d.code)} ${d.title}${d.path ? c.dim(`  ${d.path}`) : ""}`];
  if (d.message) lines.push(`        ${d.message}`);
  if (d.since_last_green) lines.push(c.dim(`        since last green: ${d.since_last_green}`));
  d.fixes.forEach((f, i) => {
    lines.push(`        ${c.green(`fix ${i + 1}`)}: ${f.label}${f.command ? c.dim(`  (${f.command})`) : ""}`);
  });
  return lines.join("\n");
}

export function renderDiagnostics(c: Colors, ds: readonly Diagnostic[]): string {
  if (ds.length === 0) return `${c.green("no diagnostics")}\n`;
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...ds].sort((a, b) => order[a.severity] - order[b.severity]);
  const n = (s: Diagnostic["severity"]): number => ds.filter((d) => d.severity === s).length;
  return `${sorted.map((d) => renderDiagnostic(c, d)).join("\n")}\n\n${c.red(`${n("error")} error(s)`)}, ${c.yellow(`${n("warning")} warning(s)`)}, ${n("info")} info\n`;
}

export function renderToolError(c: Colors, e: ToolError): string {
  const lines = [`${c.red(c.bold(e.error))}: ${e.message}`];
  if (e.candidates && e.candidates.length > 0) lines.push(`candidates:\n${e.candidates.map((x) => `  ${x}`).join("\n")}`);
  if (e.diagnostics && e.diagnostics.length > 0) lines.push(renderDiagnostics(c, e.diagnostics).trimEnd());
  return `${lines.join("\n")}\n`;
}

export function renderOverview(c: Colors, d: OverviewData): string {
  const s = d.stack;
  const lines = [
    c.bold("Stack"),
    `  orm ${s.orm}${s.prismaSchema ? ` (${s.prismaSchema})` : ""}, routers ${s.routers.join(", ") || "none"}, validator ${s.validator ?? "none"}, tests ${s.testRunner ?? "none"}, pm ${s.packageManager}`,
    `  entry points: ${s.entryPoints.join(", ") || "none detected"}`,
    `  commands: build ${s.commands.build ?? "-"}; test ${s.commands.test ?? "-"}; typecheck ${s.commands.typecheck ?? "-"}`,
    ...s.conventions.map((x) => `  - ${x}`),
    "",
    c.bold("Graph"),
    `  ${Object.entries(d.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ")}`,
    "",
    c.bold("Health"),
    `  exposures ${d.health.exposures} (${d.health.exposuresUndeclared} undeclared, ${d.health.exposuresWithoutPolicy} without policy)`,
    `  actions ${d.health.actionsDeclared} declared / ${d.health.actionsObserve} observe, queries ${d.health.queries}, contracts ${d.health.contracts}, opaque guards ${d.health.opaqueGuards}`,
    `  events without consumer ${d.health.eventsWithoutConsumer}, stale generated tests ${d.health.staleGeneratedTests}, low-confidence nodes ${d.health.lowConfidenceNodes}`,
    `  ${d.health.errors > 0 ? c.red(`${d.health.errors} errors`) : "0 errors"}, ${d.health.warnings > 0 ? c.yellow(`${d.health.warnings} warnings`) : "0 warnings"}`,
  ];
  if (d.topModules.length > 0) lines.push("", c.bold("Top modules"), ...d.topModules.map((m) => `  ${m.file}  ${m.actions} actions, ${m.exposures} exposures`));
  lines.push("", c.bold("Quickstart"), ...d.quickstart.split("\n").map((x) => `  ${x}`));
  return `${lines.join("\n")}\n`;
}

/** `id | kind | path:line | origin | summary`, one line per hit (SPEC-MCP §6.2). */
export function renderFind(c: Colors, hits: readonly FindHit[]): string {
  if (hits.length === 0) return `${c.yellow("no matches")}\n`;
  return `${hits
    .map((h) => [c.bold(h.id), h.kind, h.path ?? "-", h.origin, `${h.summary ?? ""}${h.verify ? c.yellow(` [verify: ${h.verify}]`) : ""}`].join(" | "))
    .join("\n")}\n`;
}

export function renderInspect(c: Colors, d: InspectData): string {
  const n = d.node;
  const lines = [`${c.bold(n.id)}  ${c.dim(`${n.provenance.origin}${n.src ? `  ${n.src.file}:${n.src.range[0][0]}` : ""}`)}`, n.summary];
  const card = d.card;
  if (card.intent) lines.push(`Intent: ${card.intent}`);
  if (card.whoMay) lines.push(`Who may: ${card.whoMay}`);
  for (const p of card.preconditions) lines.push(`  requires ${p.clause} [tier ${p.tier}]: ${p.text}`);
  for (const p of card.postconditions) lines.push(`  ensures  ${p.clause} [tier ${p.tier}]: ${p.text}`);
  for (const p of card.invariants) lines.push(`  invariant ${p.clause}: ${p.text}`);
  if (card.effects.length > 0) lines.push(`Effects: ${card.effects.join(", ")}`);
  if (card.tests.length > 0) lines.push(`Tests: ${card.tests.join(", ")}`);
  if (d.verify) lines.push(c.yellow(`verify: ${d.verify}`));
  const edgeKinds = Object.entries(d.edges);
  if (edgeKinds.length > 0) lines.push("", c.bold("Edges"), ...edgeKinds.map(([k, ids]) => `  ${k}: ${(ids ?? []).join(", ")}`));
  if (d.dependents.length > 0) lines.push("", c.bold("Dependents"), `  ${d.dependents.join(", ")}`);
  if (d.tests) lines.push("", c.bold("Tests"), ...d.tests.map((t) => `  ${t.id}  ${t.lastResult ? JSON.stringify(t.lastResult) : "not run"}`));
  if (d.history) lines.push("", c.bold("History"), ...d.history.entries.map((h) => `  ${JSON.stringify(h)}`));
  if (d.source) lines.push("", c.bold("Source"), d.source);
  if (d.diagnostics.length > 0) lines.push("", renderDiagnostics(c, d.diagnostics).trimEnd());
  return `${lines.join("\n")}\n`;
}

export function renderImpact(c: Colors, d: Omit<ImpactResult, "diff">): string {
  const lines: string[] = [];
  if (d.message) lines.push(d.message);
  lines.push(`${c.bold("Changed")} (${d.changed.length}): ${d.changed.join(", ") || "none"}`);
  lines.push(c.bold(`Affected (${d.affected.length})`));
  for (const a of d.affected) lines.push(`  ${a.id}${a.why.length > 0 ? c.dim(`  via ${a.why.join(" > ")}`) : ""}${a.verify ? c.yellow(`  [verify: ${a.verify}]`) : ""}`);
  lines.push(c.bold(`Tests to run (${d.testsToRun.length})`));
  for (const t of d.testsToRun) lines.push(`  ${t.id}  ${c.dim(t.file)}`);
  const flags = [d.migrationNeeded ? c.yellow("migration needed") : null, d.apiBreaking ? c.red("API breaking") : null].filter(Boolean);
  if (flags.length > 0) lines.push(flags.join(", "));
  for (const w of d.contractsWeakened) lines.push(c.red(`contract ${w.op}: ${w.contract}`));
  for (const p of d.policiesRemoved) lines.push(c.red(`policy removed: ${p}`));
  return `${lines.join("\n")}\n`;
}

export function renderExplain(c: Colors, d: ExplainData): string {
  const lines = [`${c.bold(d.subject.kind)} ${d.subject.id}`];
  if (d.failure) lines.push(`${c.red("failure")}: ${d.failure.assertion}`, `  actual:   ${JSON.stringify(d.failure.actual)}`, `  expected: ${JSON.stringify(d.failure.expected)}`);
  if (d.triggeringInput) lines.push(`input: ${JSON.stringify(d.triggeringInput)}`);
  if (d.rerun) lines.push(`rerun: ${d.rerun}`);
  if (d.chain.length > 0) {
    lines.push(c.bold("Chain"));
    for (const l of d.chain) lines.push(`  ${l.role.padEnd(9)} ${l.node}  ${c.dim(l.path ?? "")}  ${l.note}${l.verify ? c.yellow(` [verify: ${l.verify}]`) : ""}`);
  }
  if (d.sinceLastGreen.length > 0) lines.push(c.bold("Since last green"), ...d.sinceLastGreen.map((o) => `  ${JSON.stringify(o)}`));
  if (d.declaration) lines.push(`declared at ${d.declaration.path} (${d.declaration.contract})${d.declaration.author ? ` by ${d.declaration.author}` : ""}`);
  if (d.stack) lines.push(c.bold("Stack"), d.stack);
  return `${lines.join("\n")}\n`;
}

export function renderCheck(c: Colors, d: CheckData): string {
  const t = d.tests;
  const lines = [renderDiagnostics(c, d.diagnostics).trimEnd(), ""];
  lines.push(`${c.bold("Tests")}: ${t.ran} ran, ${c.green(`${t.passed} passed`)}, ${t.failed > 0 ? c.red(`${t.failed} failed`) : "0 failed"}, ${t.skipped} skipped`);
  for (const f of t.failures) lines.push(`  ${c.red("FAIL")} ${f.testId}${f.contract ? ` (${f.contract})` : ""}  ${c.dim(f.file)}`, `       rerun: ${f.rerun}`);
  lines.push(c.dim(d.coverage.message));
  for (const w of d.contractsWeakened) lines.push(c.red(`contract ${w.op}: ${w.contract}`));
  for (const p of d.policiesRemoved) lines.push(c.red(`policy removed: ${p}`));
  lines.push(d.green ? c.green(c.bold("green")) : c.red(c.bold("not green")));
  return `${lines.join("\n")}\n`;
}

export function renderProposals(c: Colors, ps: ReadonlyArray<{ target: string; patch: string; evidence: string[] }>, message?: string): string {
  if (ps.length === 0) return `${c.yellow("nothing to suggest: every Exposure is declared")}\n`;
  return `${ps.map((p) => [c.bold(p.target), ...p.evidence.map((e) => c.dim(`  - ${e}`)), p.patch.trimEnd()].join("\n")).join("\n\n")}\n`;
}
