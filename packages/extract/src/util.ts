/**
 * Small shared helpers: POSIX paths, hashing, ts-morph positions to IR positions, provenance builders.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Node as TsNode, SourceFile } from "ts-morph";
import type { Evidence, ExtractorId, Position, Provenance, SourceRange } from "@averri/ir";

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Repo-relative POSIX path of an absolute path; never starts with `./`. */
export function relPath(rootDir: string, absolute: string): string {
  const rel = toPosix(path.relative(rootDir, absolute));
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

export function absPath(rootDir: string, rel: string): string {
  return path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
}

/** Position of an offset: line 1-based, column 0-based (SPEC-IR §2.2; ts-morph returns both 1-based). */
export function positionOf(file: SourceFile, pos: number): Position {
  const { line, column } = file.getLineAndColumnAtPos(pos);
  return [line, column - 1];
}

/** Source range of a ts-morph node, end exclusive, leading trivia excluded. */
export function rangeOf(repoFile: string, node: TsNode): SourceRange {
  const sf = node.getSourceFile();
  return { file: repoFile, range: [positionOf(sf, node.getStart()), positionOf(sf, node.getEnd())] };
}

export function extracted(extractor: ExtractorId, confidence: number, evidence: Evidence[]): Provenance {
  return { origin: "extracted", extractor, confidence: clamp01(confidence), evidence };
}

export function clamp01(n: number): number {
  const c = n < 0 ? 0 : n > 1 ? 1 : n;
  return Math.round(c * 1000) / 1000;
}

/** Trim a derived summary to the `<= 200` chars the schema requires. */
export function summary(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= 200 ? one : `${one.slice(0, 197)}...`;
}

/** Collapse whitespace in a source snippet so middleware/handler texts are stable across formatting. */
export function compactText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .replace(/\s+,/g, ",")
    .trim();
}

export function uncapitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

/** Number of lines of a text (a trailing newline does not start a new line). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith("\n")) n--;
  return n;
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function uniq<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}
