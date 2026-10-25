/**
 * Reader for `.averri/traces/<YYYY-MM-DD>.<pid>.jsonl` (one ActionTrace per line, written by
 * `@averri/contracts`). The compiler does not import core/contracts (D-2), so the record shape is
 * restated structurally here and every line is parsed defensively.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EventId, HttpMethod } from "@averri/ir";
import { cachePath } from "./cache.js";

export type TracePhaseRecord =
  | { phase: "validate"; ok: boolean; issues?: unknown[] }
  | { phase: "authorize"; ok: boolean; policy: string | null; decision: "allow" | "deny" | "public" | "unauthenticated"; observed: boolean }
  | {
      phase: "requires" | "ensures";
      ok: boolean;
      contract: string;
      tier: "expr" | "predicate" | "guard";
      evaluated?: Record<string, { lhs: unknown; rhs: unknown }>;
      undefinedRefs?: string[];
      durationMs: number;
      message?: string;
    }
  | { phase: "run"; ok: boolean; durationMs: number; dbCalls: number; error?: string }
  | { phase: "emit"; ok: boolean; events: Array<{ event: EventId; payloadHash: string }>; error?: string };

export interface TraceRecord {
  traceId: string;
  action: string;
  mode: "declared" | "observe";
  startedAt: string;
  durationMs: number;
  actor: { id: string; summary: string } | null;
  phases: TracePhaseRecord[];
  outcome: { ok: true } | { ok: false; phase: string; contract?: string; message: string; committed: boolean };
  request?: { method: HttpMethod; path: string; body: unknown; headers: Record<string, string> };
  test?: { file: string; title: string };
}

export function tracesDir(root: string): string {
  return cachePath(root, "traces");
}

function isTrace(v: unknown): v is TraceRecord {
  const t = v as TraceRecord;
  return typeof v === "object" && v !== null && typeof t.traceId === "string" && typeof t.action === "string" && Array.isArray(t.phases) && typeof t.outcome === "object";
}

/** Every readable trace, oldest first (by startedAt, then traceId). */
export function readTraces(root: string): TraceRecord[] {
  const dir = tracesDir(root);
  if (!fs.existsSync(dir)) return [];
  const out: TraceRecord[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as unknown;
        if (isTrace(v)) out.push(v);
      } catch {
        /* partial line from a concurrent writer */
      }
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.traceId < b.traceId ? -1 : 1));
}

export function findTrace(root: string, traceId: string): TraceRecord | null {
  return readTraces(root).find((t) => t.traceId === traceId) ?? null;
}

/** Traces recorded under a Vitest test (matched by file and by title or by an id prefix in the title). */
export function tracesForTest(root: string, test: { file?: string; title?: string; id?: string }): TraceRecord[] {
  return readTraces(root).filter((t) => {
    if (!t.test) return false;
    if (test.file && !t.test.file.endsWith(test.file) && !test.file.endsWith(t.test.file)) return false;
    if (test.title && t.test.title === test.title) return true;
    if (test.id && t.test.title.includes(`[${test.id}]`)) return true;
    return !test.title && !test.id;
  });
}
