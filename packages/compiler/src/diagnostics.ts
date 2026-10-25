/**
 * The only way to create a Diagnostic (SPEC-DIAGNOSTICS §6): `emit(code, draft)` fills severity,
 * title and docs from the registry and asserts the fix rule; `finalizeDiagnostics` derives `path`,
 * trims to the 300-token budget (patches excluded), caps patches, sorts (severity, then path) and
 * assigns the per-build `D-nnnn` ids.
 */

import {
  DIAGNOSTIC_CODES,
  compareSeverity,
  formatDiagnosticId,
  isSeverityAllowed,
  type CauseLink,
  type Diagnostic,
  type DiagnosticCode,
  type Fix,
  type Node,
  type NodeId,
  type Severity,
  type SourceRange,
} from "@averri/ir";
import { MAX_PATCH_CHARS, makePatch, patchApplies, applyEdits, type TextEdit } from "./patch.js";
import { compareStrings, pathOf } from "./util.js";

export interface DiagnosticDraft {
  /** Lower than the registry severity for a documented sub-case; never higher. */
  severity?: Severity;
  title?: string;
  message?: string;
  node: NodeId | null;
  src?: SourceRange | null;
  cause?: CauseLink[];
  related?: NodeId[];
  fixes?: Fix[];
}

/** Budget for a diagnostic without its patches (SPEC-DIAGNOSTICS §1). */
export const DIAGNOSTIC_CHAR_BUDGET = 1200;

export class DiagnosticRuleError extends Error {}

/** Create a diagnostic (id assigned later by {@link finalizeDiagnostics}). */
export function emit(code: DiagnosticCode, draft: DiagnosticDraft): Diagnostic {
  const info = DIAGNOSTIC_CODES[code];
  const severity = draft.severity ?? info.severity;
  if (!isSeverityAllowed(code, severity)) {
    throw new DiagnosticRuleError(`${code}: severity ${severity} is above the registry maximum ${info.severity}`);
  }
  const fixes = draft.fixes ?? [];
  if (fixes.length > 0 && !info.deterministicFix) {
    throw new DiagnosticRuleError(`${code} has no deterministic fix in the registry but a fix was attached`);
  }
  for (const f of fixes) {
    if (f.patch === undefined && f.command === undefined) throw new DiagnosticRuleError(`${code}: a fix needs a patch or a command`);
  }
  const title = trimTitle(draft.title ?? info.title);
  const d: Diagnostic = {
    id: "D-0000",
    code,
    severity,
    title,
    node: draft.node,
    path: pathOf(draft.src ?? null),
    src: draft.src ?? null,
    cause: draft.cause ?? (draft.node ? [{ node: draft.node, why: title }] : []),
    related: dedupeIds(draft.related ?? []),
    fixes,
    since_last_green: null,
    docs: info.docs,
  };
  if (draft.message !== undefined) d.message = draft.message;
  return d;
}

function trimTitle(t: string): string {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length <= 80 ? one : `${one.slice(0, 77)}...`;
}

function dedupeIds(ids: readonly NodeId[]): NodeId[] {
  return Array.from(new Set(ids));
}

/**
 * Build a patch fix from text edits on one file and dry-run it (SPEC-DIAGNOSTICS §3.4). Returns null
 * when the edits produce no change or the patch does not apply.
 */
export function patchFix(label: string, evidence: string, file: string, original: string, edits: readonly TextEdit[]): Fix | null {
  let next: string;
  try {
    next = applyEdits(original, edits);
  } catch {
    return null;
  }
  const patch = makePatch(file, original, next);
  if (patch === null) return null;
  if (!patchApplies(patch, (f) => (f === file ? original : null))) return null;
  if (patch.length > MAX_PATCH_CHARS) return null;
  return { label, evidence, patch };
}

export interface FinalizeOptions {
  nodes?: Readonly<Record<string, Node>>;
  /** Computes `since_last_green` for the ids in `cause ∪ related`; null when no green build exists. */
  sinceLastGreen?: ((ids: NodeId[]) => string | null) | null;
}

/** Derive `path`, enforce budgets, sort and number. Pure: returns new objects. */
export function finalizeDiagnostics(diagnostics: readonly Diagnostic[], options: FinalizeOptions = {}): Diagnostic[] {
  const prepared = diagnostics.map((d0) => {
    const d: Diagnostic = { ...d0, cause: d0.cause.slice(0, 4), related: dedupeIds(d0.related).slice(0, 5) };
    if (d.path === null) {
      const nodeSrc = d.node && options.nodes ? options.nodes[d.node]?.src ?? null : null;
      d.path = pathOf(d.src ?? nodeSrc);
    }
    d.fixes = d.fixes
      .map((f) => {
        if (f.patch !== undefined && f.patch.length > MAX_PATCH_CHARS) {
          const { patch: _drop, ...rest } = f;
          return rest.command !== undefined ? rest : null;
        }
        return f;
      })
      .filter((f): f is Fix => f !== null);
    if (options.sinceLastGreen) {
      const ids = [...d.cause.map((c) => c.node), ...d.related];
      if (d.node) ids.push(d.node);
      d.since_last_green = options.sinceLastGreen(Array.from(new Set(ids)));
    }
    return trimToBudget(d);
  });
  prepared.sort(
    (a, b) =>
      compareSeverity(a.severity, b.severity) ||
      compareStrings(a.path ?? "￿", b.path ?? "￿") ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.node ?? "", b.node ?? "") ||
      compareStrings(a.title, b.title) ||
      compareStrings(a.message ?? "", b.message ?? ""),
  );
  return prepared.map((d, i) => ({ ...d, id: formatDiagnosticId(i + 1) }));
}

/** Serialised size without patches. */
export function budgetSize(d: Diagnostic): number {
  return JSON.stringify({ ...d, fixes: d.fixes.map(({ patch: _p, ...rest }) => rest) }).length;
}

function trimToBudget(d: Diagnostic): Diagnostic {
  let cur = d;
  if (budgetSize(cur) <= DIAGNOSTIC_CHAR_BUDGET) return cur;
  if (cur.message !== undefined) {
    const over = budgetSize(cur) - DIAGNOSTIC_CHAR_BUDGET;
    const keep = Math.max(0, cur.message.length - over - 3);
    cur = { ...cur, message: keep > 0 ? `${cur.message.slice(0, keep)}...` : "" };
    if (cur.message === "") {
      const { message: _m, ...rest } = cur;
      cur = rest;
    }
  }
  while (budgetSize(cur) > DIAGNOSTIC_CHAR_BUDGET && cur.cause.length > 1) cur = { ...cur, cause: cur.cause.slice(0, -1) };
  while (budgetSize(cur) > DIAGNOSTIC_CHAR_BUDGET && cur.related.length > 0) cur = { ...cur, related: cur.related.slice(0, -1) };
  if (budgetSize(cur) > DIAGNOSTIC_CHAR_BUDGET) {
    cur = { ...cur, cause: cur.cause.map((c) => ({ node: c.node, why: c.why.length > 120 ? `${c.why.slice(0, 117)}...` : c.why })) };
  }
  return cur;
}
