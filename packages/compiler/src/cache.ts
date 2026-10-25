/**
 * The `.averri/` cache (ARCHITECTURE §4): graph.json, build.lock, last-check.json, last-green.json,
 * snapshots/<contentHash>.json (LRU 20, last-green pinned), openapi.json, cards/. Everything here is
 * rebuildable; a file that fails validation is treated as absent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { safeValidateGraph, serializeGraph, type Diagnostic, type Graph, type GraphMeta, type TestId, type TestResultSummary } from "@averri/ir";

export const AVERRI_DIR = ".averri";
export const SNAPSHOT_LIMIT = 20;
export const LOCK_STALE_MS = 60_000;

export function averriDir(root: string): string {
  return path.join(root, AVERRI_DIR);
}

export function cachePath(root: string, ...parts: string[]): string {
  return path.join(averriDir(root), ...parts);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write atomically (temp file + rename) so concurrent readers never see a partial file. */
export function writeFileAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Read and validate a graph file; null when missing or invalid (callers rebuild). */
export function readGraphFile(file: string): Graph | null {
  if (!fs.existsSync(file)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const r = safeValidateGraph(json);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

export function readCachedGraph(root: string): Graph | null {
  return readGraphFile(cachePath(root, "graph.json"));
}

export function writeCachedGraph(root: string, graph: Graph): void {
  writeFileAtomic(cachePath(root, "graph.json"), serializeGraph(graph));
}

// --- snapshots ---------------------------------------------------------------

export function snapshotRel(contentHash: string): string {
  return `snapshots/${contentHash}.json`;
}

export function writeSnapshot(root: string, graph: Graph): string {
  const rel = snapshotRel(graph.meta.contentHash);
  const file = cachePath(root, rel);
  // A snapshot of the same content written by another Averri build is replaced: its derived facts may differ (D-41j).
  if (!fs.existsSync(file) || readGraphFile(file)?.meta.averriVersion !== graph.meta.averriVersion) writeFileAtomic(file, serializeGraph(graph));
  else {
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch {
      /* ignore */
    }
  }
  pruneSnapshots(root);
  return rel;
}

export function readSnapshot(root: string, rel: string): Graph | null {
  const file = cachePath(root, rel);
  const g = readGraphFile(file);
  if (g) {
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch {
      /* ignore */
    }
  }
  return g;
}

/**
 * A snapshot by content hash. With `averriVersion` a snapshot written by a different Averri build is
 * rejected (D-41j): the content hash does not cover the compiler's derivation logic, so reusing it as
 * a diff base would report compiler changes as weakened contracts or API breaks. Explicit reads of the
 * pinned last-green snapshot (`readSnapshot`) are not version-gated.
 */
export function readSnapshotByHash(root: string, contentHash: string, averriVersion?: string): Graph | null {
  const g = readSnapshot(root, snapshotRel(contentHash));
  if (g && averriVersion !== undefined && g.meta.averriVersion !== averriVersion) return null;
  return g;
}

/** Keep the 20 most recently used snapshots plus the one pinned by last-green.json. */
export function pruneSnapshots(root: string, limit = SNAPSHOT_LIMIT): string[] {
  const dir = cachePath(root, "snapshots");
  if (!fs.existsSync(dir)) return [];
  const pinned = readLastGreen(root)?.snapshot ?? null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || (a.f < b.f ? -1 : 1));
  const removed: string[] = [];
  let kept = 0;
  for (const { f } of files) {
    if (pinned === `snapshots/${f}`) continue;
    if (kept < limit) {
      kept++;
      continue;
    }
    fs.unlinkSync(path.join(dir, f));
    removed.push(f);
  }
  return removed;
}

// --- last-check / last-green --------------------------------------------------

export interface TestRunRecord {
  id: TestId;
  title: string;
  file: string;
  status: TestResultSummary["status"];
  failedContracts?: string[];
  message?: string;
  traceId?: string;
}

export interface LastCheck {
  meta: { contentHash: string; at?: string };
  diagnostics: Diagnostic[];
  tests: TestRunRecord[];
}

export interface LastGreen {
  meta: GraphMeta;
  tests: TestRunRecord[];
  at: string;
  snapshot: string;
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readLastCheck(root: string): LastCheck | null {
  const v = readJson<LastCheck>(cachePath(root, "last-check.json"));
  return v && v.meta && typeof v.meta.contentHash === "string" && Array.isArray(v.diagnostics) ? v : null;
}

export function writeLastCheck(root: string, value: LastCheck): void {
  writeFileAtomic(cachePath(root, "last-check.json"), `${JSON.stringify(value, null, 2)}\n`);
}

export function readLastGreen(root: string): LastGreen | null {
  const v = readJson<LastGreen>(cachePath(root, "last-green.json"));
  return v && typeof v.snapshot === "string" && v.meta ? v : null;
}

export function writeLastGreen(root: string, value: LastGreen): void {
  writeFileAtomic(cachePath(root, "last-green.json"), `${JSON.stringify(value, null, 2)}\n`);
}

/** The graph pinned by last-green.json, or null. */
export function readLastGreenGraph(root: string): Graph | null {
  const lg = readLastGreen(root);
  return lg ? readSnapshot(root, lg.snapshot) : null;
}

// --- build lock ---------------------------------------------------------------

export interface Lock {
  release(): void;
}

function tryAcquire(file: string): boolean {
  try {
    ensureDir(path.dirname(file));
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(file);
        return tryAcquire(file);
      }
    } catch {
      /* raced: someone else released it */
    }
    return false;
  }
}

/** Serialise builds through `.averri/build.lock` (stale locks older than 60 s are broken). */
export async function acquireBuildLock(root: string, timeoutMs = 120_000, pollMs = 50): Promise<Lock> {
  const file = cachePath(root, "build.lock");
  const start = Date.now();
  while (!tryAcquire(file)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return {
    release() {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    },
  };
}
