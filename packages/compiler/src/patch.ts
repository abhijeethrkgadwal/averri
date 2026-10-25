/**
 * Unified-diff patches for deterministic fixes (SPEC-DIAGNOSTICS §3): text edits -> a `git apply`
 * compatible patch with up to 3 lines of context, plus an in-memory applier used as the mandatory
 * dry run before a patch is attached to a diagnostic.
 */

export interface TextEdit {
  /** Offset into the original text (inclusive). */
  start: number;
  /** Offset into the original text (exclusive). */
  end: number;
  text: string;
}

export const MAX_PATCH_CHARS = 4000;
const CONTEXT = 3;

/** Apply non-overlapping edits (any order) to a text. Throws on overlap. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) throw new Error("overlapping edits");
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos);
}

interface Lines {
  lines: string[];
  /** True when the text ends with "\n" (the last element of `lines` is then a complete line). */
  eol: boolean;
}

function splitLines(text: string): Lines {
  if (text.length === 0) return { lines: [], eol: true };
  const eol = text.endsWith("\n");
  const lines = (eol ? text.slice(0, -1) : text).split("\n");
  return { lines, eol };
}

/** Line `i` of `side` including its end-of-line state, for equality tests. */
function lineKey(side: Lines, i: number): string {
  const last = i === side.lines.length - 1;
  return `${side.lines[i] as string}${last && !side.eol ? "\u0000noeol" : ""}`;
}

type Op = { tag: " " | "-" | "+"; a: number; b: number };

/** Line-level Myers diff (O((N+M)·D)); `a`/`b` are line keys. */
export function diffLineKeys(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) x = v[offset + k + 1] as number;
      else x = (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  trace.push(v.slice());
  // backtrack
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vv[offset + k - 1] as number) < (vv[offset + k + 1] as number))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : (vv[offset + prevK] as number);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ tag: " ", a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ tag: "+", a: x, b: y - 1 });
    else ops.push({ tag: "-", a: x - 1, b: y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ tag: " ", a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

/**
 * A unified diff turning `before` into `after` for repo-relative `file`: one hunk per changed region
 * with up to 3 context lines (regions whose context overlaps are merged). Returns null when the texts
 * are identical.
 */
export function makePatch(file: string, before: string, after: string): string | null {
  if (before === after) return null;
  const a = splitLines(before);
  const b = splitLines(after);
  const ak = a.lines.map((_, i) => lineKey(a, i));
  const bk = b.lines.map((_, i) => lineKey(b, i));
  const ops = diffLineKeys(ak, bk);
  const changed = ops.map((o, i) => (o.tag === " " ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return null;
  // group op indices into hunks
  const groups: Array<[number, number]> = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= 2 * CONTEXT + 1) last[1] = i;
    else groups.push([i, i]);
  }
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  const pushLine = (body: string[], prefix: string, side: Lines, index: number): void => {
    body.push(`${prefix}${side.lines[index] as string}`);
    if (index === side.lines.length - 1 && !side.eol) body.push("\\ No newline at end of file");
  };
  for (const [s, e] of groups) {
    const from = Math.max(0, s - CONTEXT);
    const to = Math.min(ops.length - 1, e + CONTEXT);
    const body: string[] = [];
    let aStart = -1;
    let bStart = -1;
    let aLen = 0;
    let bLen = 0;
    for (let i = from; i <= to; i++) {
      const o = ops[i] as Op;
      if (o.tag === " " || o.tag === "-") {
        if (aStart < 0) aStart = o.a;
        aLen++;
      }
      if (o.tag === " " || o.tag === "+") {
        if (bStart < 0) bStart = o.b;
        bLen++;
      }
      if (o.tag === " ") pushLine(body, " ", a, o.a);
      else if (o.tag === "-") pushLine(body, "-", a, o.a);
      else pushLine(body, "+", b, o.b);
    }
    // positions for empty sides: the line before the hunk
    const firstOp = ops[from] as Op;
    const aPos = aLen === 0 ? firstOp.a : aStart + 1;
    const bPos = bLen === 0 ? firstOp.b : bStart + 1;
    out.push(`@@ -${aPos},${aLen} +${bPos},${bLen} @@`, ...body);
  }
  return `${out.join("\n")}\n`;
}

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ParsedFilePatch {
  oldFile: string | null;
  newFile: string | null;
  hunks: ParsedHunk[];
}

/** Parse a (git-style) unified diff into per-file hunks. Unknown header lines are ignored. */
export function parseUnifiedDiff(text: string): ParsedFilePatch[] {
  const out: ParsedFilePatch[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cur: ParsedFilePatch | null = null;
  let hunk: ParsedHunk | null = null;
  let remainingOld = 0;
  let remainingNew = 0;
  const stripPrefix = (p: string): string | null => {
    const t = p.trim().split("\t")[0] as string;
    if (t === "/dev/null") return null;
    return t.replace(/^[ab]\//, "");
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const inHunk = hunk !== null && (remainingOld > 0 || remainingNew > 0);
    if (!inHunk && line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      cur = { oldFile: stripPrefix(line.slice(4)), newFile: stripPrefix((lines[i + 1] as string).slice(4)), hunks: [] };
      out.push(cur);
      hunk = null;
      i++;
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && cur && !inHunk) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      remainingOld = hunk.oldLines;
      remainingNew = hunk.newLines;
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) {
      hunk.lines.push(line);
      continue;
    }
    if (!inHunk) continue;
    const tag = line.length === 0 ? " " : line[0];
    if (tag === " ") {
      hunk.lines.push(line.length === 0 ? " " : line);
      remainingOld--;
      remainingNew--;
    } else if (tag === "-") {
      hunk.lines.push(line);
      remainingOld--;
    } else if (tag === "+") {
      hunk.lines.push(line);
      remainingNew--;
    }
  }
  return out;
}

/**
 * Apply one file's hunks to `original` (strict: context and removed lines must match exactly at the
 * stated positions, like `git apply --check`). Returns the new text or null when it does not apply.
 */
export function applyFilePatch(original: string, patch: ParsedFilePatch): string | null {
  const src = splitLines(original);
  const out: string[] = [];
  let pos = 0;
  /** Whether the last new-side line written by a hunk carries a "\ No newline" marker. */
  let lastNewNoEol = false;
  for (const h of patch.hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    if (start < pos || start > src.lines.length) return null;
    while (pos < start) out.push(src.lines[pos++] as string);
    let removed = 0;
    let added = 0;
    for (let k = 0; k < h.lines.length; k++) {
      const l = h.lines[k] as string;
      if (l.startsWith("\\")) continue;
      const next = h.lines[k + 1];
      const noEol = next !== undefined && next.startsWith("\\");
      const tag = l[0];
      const content = l.slice(1);
      if (tag === " " || tag === "-") {
        if (src.lines[pos] !== content) return null;
        const isLast = pos === src.lines.length - 1;
        if (noEol !== (isLast && !src.eol)) return null;
        pos++;
        removed++;
        if (tag === " ") {
          out.push(content);
          added++;
          lastNewNoEol = noEol;
        }
      } else if (tag === "+") {
        out.push(content);
        added++;
        lastNewNoEol = noEol;
      }
    }
    if (removed !== h.oldLines || added !== h.newLines) return null;
  }
  const hunkReachedEnd = pos === src.lines.length;
  while (pos < src.lines.length) out.push(src.lines[pos++] as string);
  if (out.length === 0) return "";
  const eol = hunkReachedEnd ? !lastNewNoEol : src.eol;
  return out.join("\n") + (eol ? "\n" : "");
}

/**
 * Dry run of a multi-file patch against file contents (`read(path)` returns null for missing files).
 * True when every file patch applies.
 */
export function patchApplies(patch: string, read: (file: string) => string | null): boolean {
  const files = parseUnifiedDiff(patch);
  if (files.length === 0 || files.some((f) => f.hunks.length === 0)) return false;
  for (const f of files) {
    if (f.oldFile === null) continue;
    const original = read(f.oldFile);
    if (original === null) return false;
    if (applyFilePatch(original, f) === null) return false;
  }
  return true;
}

/** Reverse a parsed patch (swap old/new sides), used to rebuild the pre-diff tree for `impact {diff}`. */
export function reversePatch(files: readonly ParsedFilePatch[]): ParsedFilePatch[] {
  return files.map((f) => ({
    oldFile: f.newFile,
    newFile: f.oldFile,
    hunks: f.hunks.map((h) => ({
      oldStart: h.newStart,
      oldLines: h.newLines,
      newStart: h.oldStart,
      newLines: h.oldLines,
      lines: h.lines.map((l) => (l.startsWith("+") ? `-${l.slice(1)}` : l.startsWith("-") ? `+${l.slice(1)}` : l)),
    })),
  }));
}

export interface ChangedFile {
  /** New-side path (old-side path for deletions). */
  file: string;
  oldFile: string | null;
  newFile: string | null;
  /** Changed line ranges on the new side (1-based, inclusive). Deletions mark the adjacent line. */
  newRanges: Array<[number, number]>;
  /** Removed line ranges on the old side. */
  oldRanges: Array<[number, number]>;
}

/** Changed line ranges per file, for mapping a diff to nodes (`impact {diff}`). */
export function changedLines(files: readonly ParsedFilePatch[]): ChangedFile[] {
  return files.map((f) => {
    const newRanges: Array<[number, number]> = [];
    const oldRanges: Array<[number, number]> = [];
    for (const h of f.hunks) {
      let oldLine = h.oldStart;
      let newLine = h.newStart;
      for (const l of h.lines) {
        if (l.startsWith("\\")) continue;
        if (l.startsWith("-")) {
          oldRanges.push([oldLine, oldLine]);
          newRanges.push([Math.max(1, newLine - 1), Math.max(1, newLine)]);
          oldLine++;
        } else if (l.startsWith("+")) {
          newRanges.push([newLine, newLine]);
          newLine++;
        } else {
          oldLine++;
          newLine++;
        }
      }
    }
    return {
      file: (f.newFile ?? f.oldFile) as string,
      oldFile: f.oldFile,
      newFile: f.newFile,
      newRanges: mergeRanges(newRanges),
      oldRanges: mergeRanges(oldRanges),
    };
  });
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
