/**
 * Cheap staleness key (SPEC-MCP §4): the content hash over the same input-file set the extractor
 * hashes (SPEC-IR §6), computed without a ts-morph project so `loadOrBuild` can serve the cache in
 * milliseconds. Generated tests are excluded (D-13). Must agree with `@averri/extract`'s `contentHash`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import { EXTRACT_DEFAULTS, contentHashOf, type InputFile } from "@averri/extract";
import type { LoweredConfig } from "./config.js";
import { compareStrings, sha256, toPosix } from "./util.js";

const IGNORE = ["**/node_modules/**", "**/dist/**", "**/.averri/**", "**/*.d.ts"];

function normalizeDir(p: string): string {
  let n = toPosix(p).trim();
  if (n.startsWith("./")) n = n.slice(2);
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}

/** The input files of a project (sorted by path) with their sha256. */
export function inputFiles(root: string, config: LoweredConfig): InputFile[] {
  const paths = new Set<string>();
  for (const sr of config.sourceRoots.map(normalizeDir)) {
    if (!fs.existsSync(path.join(root, sr))) continue;
    for (const f of fg.sync(`${sr}/**/*.{ts,tsx,mts,cts}`, { cwd: root, ignore: IGNORE, onlyFiles: true, dot: false })) paths.add(toPosix(f));
  }
  const gen = `${normalizeDir(config.test.generatedDir)}/`;
  for (const f of fg.sync([...EXTRACT_DEFAULTS.testGlobs], { cwd: root, ignore: IGNORE, onlyFiles: true, dot: false })) {
    const p = toPosix(f);
    if (!p.startsWith(gen)) paths.add(p);
  }
  if (config.entryPointsDeclared) {
    for (const ep of config.entryPoints.map(normalizeDir)) if (fs.existsSync(path.join(root, ep)) && /\.[cm]?tsx?$/.test(ep)) paths.add(ep);
  }
  if (config.file && fs.existsSync(path.join(root, config.file))) paths.add(config.file);
  if (fs.existsSync(path.join(root, config.prismaSchema))) paths.add(normalizeDir(config.prismaSchema));
  if (fs.existsSync(path.join(root, "package.json"))) paths.add("package.json");
  const out: InputFile[] = [];
  for (const p of [...paths].sort(compareStrings)) {
    const abs = path.join(root, p);
    if (!fs.existsSync(abs)) continue;
    out.push({ path: p, hash: sha256(fs.readFileSync(abs)) });
  }
  return out;
}

export function computeContentHash(root: string, config: LoweredConfig): string {
  return contentHashOf(inputFiles(root, config));
}
