/**
 * Small shared helpers: positions, ranges, text, edit distance, deterministic ordering.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { Node, type SourceFile } from "ts-morph";
import type { Position, SourceRange } from "@averri/ir";

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

export function relPath(rootDir: string, absolute: string): string {
  const rel = toPosix(path.relative(rootDir, absolute));
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function uniq<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

export function uniqSorted<T extends string>(items: Iterable<T>): T[] {
  return Array.from(new Set(items)).sort(compareStrings);
}

/** Line 1-based, column 0-based (SPEC-IR §2.2). */
export function positionOf(sf: SourceFile, pos: number): Position {
  const { line, column } = sf.getLineAndColumnAtPos(pos);
  return [line, column - 1];
}

export function rangeOf(file: string, node: Node): SourceRange {
  const sf = node.getSourceFile();
  return { file, range: [positionOf(sf, node.getStart()), positionOf(sf, node.getEnd())] };
}

export function pathOf(src: SourceRange | null | undefined): string | null {
  return src ? `${src.file}:${src.range[0][0]}` : null;
}

/** One line, <= 200 chars (node summaries). */
export function summaryText(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= 200 ? one : `${one.slice(0, 197)}...`;
}

export function compact(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 3)}...`;
}

export function uncapitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Levenshtein distance (small strings only). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] as number;
}

/** The `k` names closest to `name` by edit distance (case-insensitive), ties by name. */
export function closestNames(name: string, candidates: readonly string[], k = 3): string[] {
  const lower = name.toLowerCase();
  return [...candidates]
    .map((c) => ({ c, d: editDistance(lower, c.toLowerCase()) }))
    .sort((x, y) => x.d - y.d || compareStrings(x.c, y.c))
    .slice(0, k)
    .map((x) => x.c);
}

/** Number of lines of a text (a trailing newline does not start a new line). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith("\n")) n--;
  return n;
}

/** Token estimate used by every budget (SPEC-MCP §1): ceil(chars / 4) of the serialised JSON. */
export function tokensOf(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of a source-file line range (1-based, inclusive). */
export function lineSpan(text: string, start: number, end: number): string {
  return text.split("\n").slice(start - 1, end).join("\n");
}
