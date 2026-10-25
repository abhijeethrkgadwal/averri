/**
 * Diagnostic-code registry helpers (SPEC-DIAGNOSTICS §1–§2): lookup, deterministic-fix flag, family,
 * severity ordering and id formatting. Pure; no IO.
 */

import { DIAGNOSTIC_CODES, type Diagnostic, type DiagnosticCode, type DiagnosticCodeInfo, type DiagnosticId, type Severity } from "./types.js";
import { compareIds } from "./ids.js";

/** Codes that are allocated but never issued (SPEC-DIAGNOSTICS §2). */
export const RESERVED_DIAGNOSTIC_CODES = ["A2102", "A2107"] as const;

export type DiagnosticFamilyId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S9";

export interface DiagnosticFamily {
  family: DiagnosticFamilyId;
  name: string;
}

export const DIAGNOSTIC_FAMILIES: Readonly<Record<DiagnosticFamilyId, string>> = {
  S1: "identity and declarations",
  S2: "exposure and policy",
  S3: "contracts",
  S4: "effects, events and workflows",
  S5: "integrations and pitfalls",
  S6: "tests",
  S7: "extraction and graph health",
  S9: "backstops (tsc, vitest)",
};

/** Every registered code, in registry order. */
export const ALL_DIAGNOSTIC_CODES: readonly DiagnosticCode[] = Object.keys(DIAGNOSTIC_CODES) as DiagnosticCode[];

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CODES, value);
}

export function isReservedDiagnosticCode(value: string): boolean {
  return (RESERVED_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

/** Registry entry for a code. Throws on an unknown code; use {@link isDiagnosticCode} first for untrusted input. */
export function diagnosticInfo(code: DiagnosticCode): DiagnosticCodeInfo {
  const info = DIAGNOSTIC_CODES[code] as DiagnosticCodeInfo | undefined;
  if (!info) throw new Error(`unknown diagnostic code "${String(code)}"`);
  return info;
}

/** Registry entry or `null` for an untrusted string. */
export function lookupDiagnosticCode(code: string): DiagnosticCodeInfo | null {
  return isDiagnosticCode(code) ? DIAGNOSTIC_CODES[code] : null;
}

/** True when the compiler MAY attach a Fix to this code (SPEC-DIAGNOSTICS §3 rule 1). */
export function hasDeterministicFix(code: DiagnosticCode): boolean {
  return diagnosticInfo(code).deterministicFix;
}

/** Family derived from the code's first digit (`A2103` -> S2). Works for reserved codes too. */
export function diagnosticFamily(code: string): DiagnosticFamily | null {
  const m = /^A(\d)\d{3}$/.exec(code);
  if (!m) return null;
  const family = `S${m[1]}` as DiagnosticFamilyId;
  const name = DIAGNOSTIC_FAMILIES[family] as string | undefined;
  return name ? { family, name } : null;
}

/** Registered codes of one family, in registry order. */
export function codesOfFamily(family: DiagnosticFamilyId): DiagnosticCode[] {
  return ALL_DIAGNOSTIC_CODES.filter((c) => diagnosticFamily(c)?.family === family);
}

/** `error` < `warning` < `info` (the list ordering of SPEC-DIAGNOSTICS §1). */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/** Registry severity is the maximum: a rule may lower it, never raise it. */
export function maxSeverity(code: DiagnosticCode): Severity {
  return diagnosticInfo(code).severity;
}

export function isSeverityAllowed(code: DiagnosticCode, severity: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[maxSeverity(code)];
}

/** Ordering for diagnostic lists: severity (error first), then `path`, then id. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return compareSeverity(a.severity, b.severity) || compareIds(a.path ?? "", b.path ?? "") || compareIds(a.id, b.id);
}

/** `D-` + zero-padded (width 4) one-based sequence number. */
export function formatDiagnosticId(sequence: number): DiagnosticId {
  if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError(`diagnostic sequence must be a positive integer, got ${sequence}`);
  return `D-${String(sequence).padStart(4, "0")}`;
}

export function parseDiagnosticId(id: string): number | null {
  const m = /^D-(\d{4,})$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Checks a diagnostic against the registry rules (fix flag, severity cap, docs uri). Empty when consistent. */
export function diagnosticConsistencyIssues(d: Diagnostic): string[] {
  const issues: string[] = [];
  if (!isDiagnosticCode(d.code)) return [`code "${String(d.code)}" is not registered`];
  const info = diagnosticInfo(d.code);
  if (!info.deterministicFix && d.fixes.length > 0) issues.push(`${d.code} has deterministicFix: false but carries ${d.fixes.length} fix(es)`);
  if (!isSeverityAllowed(d.code, d.severity)) issues.push(`${d.code} severity "${d.severity}" is above the registry maximum "${info.severity}"`);
  if (d.docs !== null && d.docs !== info.docs) issues.push(`${d.code} docs "${d.docs}" differs from the registry "${info.docs}"`);
  if (d.title.length > 80) issues.push(`title exceeds 80 chars (${d.title.length})`);
  if (d.related.length > 5) issues.push(`related has ${d.related.length} ids (max 5)`);
  if (d.cause.length > 4) issues.push(`cause has ${d.cause.length} links (max 4)`);
  return issues;
}

/** Counts by severity for health counters and summaries. */
export function countBySeverity(diagnostics: readonly Diagnostic[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) out[d.severity] += 1;
  return out;
}
