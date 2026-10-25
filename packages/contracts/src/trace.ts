/**
 * ActionTrace recording (ARCHITECTURE §4): one JSON line per invocation appended to
 * `.averri/traces/<YYYY-MM-DD>.<pid>.jsonl` (one file per process so Vitest workers never interleave
 * within a line), 7-day retention, plus the helpers that build the trace envelope.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ActionTrace, Actor } from "@averri/core";
import { toJsonValue } from "./values.js";

export interface TraceRecorder {
  record(trace: ActionTrace): void;
}

export interface MemoryTraceRecorder extends TraceRecorder {
  readonly traces: ActionTrace[];
  clear(): void;
}

export interface FileTraceRecorder extends TraceRecorder {
  readonly dir: string;
  /** The file this process appends to. */
  readonly file: string;
}

/** `<root>/.averri/traces`. */
export function defaultTracesDir(root: string = process.cwd()): string {
  return resolve(root, ".averri", "traces");
}

/** `YYYY-MM-DD.<pid>.jsonl` (UTC date). */
export function traceFileName(date: Date, pid: number = process.pid): string {
  return `${date.toISOString().slice(0, 10)}.${pid}.jsonl`;
}

export function newTraceId(): string {
  return randomUUID();
}

/** Keeps everything in memory (tests, `explain` in-process). */
export function memoryTraceRecorder(): MemoryTraceRecorder {
  const traces: ActionTrace[] = [];
  return {
    traces,
    record(trace) {
      traces.push(trace);
    },
    clear() {
      traces.length = 0;
    },
  };
}

export interface FileTraceRecorderOptions {
  dir?: string;
  pid?: number;
  now?: () => Date;
  /** Retention applied once, lazily, on the first write. Default 7 days; `0` disables pruning. */
  retentionDays?: number;
}

/** Appends one JSON line per trace with `appendFileSync` (atomic for lines well below the pipe buffer size). */
export function createTraceRecorder(options: FileTraceRecorderOptions = {}): FileTraceRecorder {
  const dir = options.dir ?? defaultTracesDir();
  const now = options.now ?? (() => new Date());
  const file = join(dir, traceFileName(now(), options.pid ?? process.pid));
  let prepared = false;
  return {
    dir,
    file,
    record(trace) {
      if (!prepared) {
        mkdirSync(dir, { recursive: true });
        if ((options.retentionDays ?? 7) > 0) pruneTraces(dir, options.retentionDays ?? 7, now());
        prepared = true;
      }
      appendFileSync(file, `${JSON.stringify(toJsonValue(trace))}\n`, "utf8");
    },
  };
}

let defaultRecorder: FileTraceRecorder | null = null;

/** Process-wide file recorder in `defaultTracesDir()`, created on first use. */
export function defaultTraceRecorder(): FileTraceRecorder {
  if (defaultRecorder === null) defaultRecorder = createTraceRecorder();
  return defaultRecorder;
}

/** Deletes `*.jsonl` trace files whose date prefix is older than `retentionDays`. Returns the removed file names. */
export function pruneTraces(dir: string, retentionDays: number = 7, now: Date = new Date()): string[] {
  if (!existsSync(dir)) return [];
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.\d+\.jsonl$/.exec(name);
    if (match === null) continue;
    const day = Date.parse(`${match[1]}T00:00:00.000Z`);
    const path = join(dir, name);
    let stale = Number.isFinite(day) && day < cutoff;
    if (!stale) {
      try {
        stale = statSync(path).mtimeMs < cutoff && day < cutoff;
      } catch {
        stale = false;
      }
    }
    if (stale) {
      try {
        unlinkSync(path);
        removed.push(name);
      } catch {
        // another worker may have removed it first
      }
    }
  }
  return removed;
}

/** Parses a JSONL trace file; malformed lines are skipped. */
export function readTraceFile(file: string): ActionTrace[] {
  if (!existsSync(file)) return [];
  const out: ActionTrace[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as ActionTrace);
    } catch {
      // skip partial line
    }
  }
  return out;
}

/** `{ id, summary: "<role ?? ''>#<id>" }` truncated to 40 chars; no PII beyond id and role. */
export function actorSummary(actor: Actor | null | undefined): ActionTrace["actor"] {
  if (actor === null || actor === undefined || typeof actor !== "object") return null;
  const id = String((actor as { id?: unknown }).id ?? "");
  const role = (actor as { role?: unknown }).role;
  const summary = `${typeof role === "string" ? role : ""}#${id}`.slice(0, 40);
  return { id, summary };
}

const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "proxy-authorization"]);

/** Lower-cases header names and replaces credential-bearing values with `[redacted]`. */
export function redactHeaders(headers: Record<string, string | string[] | undefined> | Headers | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined || headers === null) return out;
  const entries: Array<[string, string]> = [];
  if (typeof (headers as Headers).forEach === "function" && !(Symbol.iterator in Object(headers) && Array.isArray(headers))) {
    (headers as Headers).forEach((value, key) => entries.push([key, value]));
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
      if (value === undefined) continue;
      entries.push([key, Array.isArray(value) ? value.join(", ") : value]);
    }
  }
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    out[name] = SECRET_HEADERS.has(name) || /secret|token|signature/.test(name) ? "[redacted]" : value;
  }
  return out;
}

/** Repo-relative POSIX path when `file` is under `root`; otherwise the input with forward slashes. */
export function toRepoRelative(file: string, root: string = process.cwd()): string {
  const rel = relative(root, file);
  const chosen = rel.startsWith("..") || resolve(rel) === rel ? file : rel;
  return chosen.replace(/\\/g, "/");
}

/**
 * The current Vitest test (`expect.getState()`), when running under Vitest; `undefined` otherwise.
 * Dynamic import so the package never requires Vitest at runtime.
 */
export async function currentVitestTest(): Promise<ActionTrace["test"] | undefined> {
  if (!process.env.VITEST) return undefined;
  try {
    const vitest = (await import("vitest")) as { expect?: { getState(): { currentTestName?: string; testPath?: string } } };
    const state = vitest.expect?.getState();
    if (!state || !state.currentTestName || !state.testPath) return undefined;
    return { file: toRepoRelative(state.testPath), title: state.currentTestName };
  } catch {
    return undefined;
  }
}
