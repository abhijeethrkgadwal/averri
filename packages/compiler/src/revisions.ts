/**
 * Graphs for other revisions, for `impact {diff}`/`{base}`/`{}` and `check` (SPEC-MCP §6.4–6.5):
 * a git ref (temporary worktree) or the working tree with a unified diff reversed (a temporary copy
 * of the input files next to the project root, so relative tsconfig `extends` and `node_modules`
 * resolution behave as in the original). Snapshots are cached by contentHash (D-14).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Graph } from "@averri/ir";
import { AVERRI_VERSION, build, type BuildOptions } from "./build.js";
import { readSnapshotByHash, writeSnapshot } from "./cache.js";
import { readConfig } from "./config.js";
import { gitWorktreeAt, linkNodeModules, removeLink } from "./git.js";
import { computeContentHash, inputFiles } from "./inputs.js";
import { applyFilePatch, parseUnifiedDiff, reversePatch } from "./patch.js";

function rebase(graph: Graph, root: string): Graph {
  return { ...graph, meta: { ...graph.meta, root: root.split("\\").join("/") } };
}

/** Build a tree directory, reusing a cached snapshot of the same content hash under `cacheRoot`. */
function buildDir(dir: string, cacheRoot: string, options: BuildOptions): Graph {
  const { config } = readConfig(dir, options.configFile);
  const hash = computeContentHash(dir, config);
  const cached = readSnapshotByHash(cacheRoot, hash, options.averriVersion ?? AVERRI_VERSION);
  if (cached) return cached;
  const g = build(dir, { ...options, writeCache: false, writeTests: false, git: false, previous: null, lastGreen: null }).graph;
  writeSnapshot(cacheRoot, g);
  return g;
}

/** The graph of `root` at git `ref` (null outside git or when the ref does not exist). */
export function buildAtRef(root: string, ref: string, options: BuildOptions = {}): Graph | null {
  const wt = gitWorktreeAt(root, ref);
  if (!wt) return null;
  try {
    if (!fs.existsSync(wt.dir)) return null;
    return rebase(buildDir(wt.dir, root, options), root);
  } finally {
    wt.dispose();
  }
}

/**
 * The graph of the working tree with `unifiedDiff` reverted (the "before" side of the diff). Throws
 * when the diff does not apply in reverse.
 */
export function buildWithDiffReverted(root: string, unifiedDiff: string, options: BuildOptions = {}): Graph {
  const abs = path.resolve(root);
  const { config } = readConfig(abs, options.configFile);
  const files = inputFiles(abs, config).map((f) => f.path);
  for (const extra of ["tsconfig.json"]) if (fs.existsSync(path.join(abs, extra))) files.push(extra);
  const parent = path.dirname(abs);
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(path.join(parent, `.averri-revert-${path.basename(abs)}-`));
  } catch {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "averri-revert-"));
  }
  try {
    for (const f of files) {
      const dst = path.join(tmp, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(abs, f), dst);
    }
    for (const fp of reversePatch(parseUnifiedDiff(unifiedDiff))) {
      const target = fp.newFile;
      const source = fp.oldFile;
      if (target === null && source !== null) {
        fs.rmSync(path.join(tmp, source), { force: true });
        continue;
      }
      if (target === null) continue;
      const current = source !== null && fs.existsSync(path.join(tmp, source)) ? fs.readFileSync(path.join(tmp, source), "utf8") : "";
      const next = applyFilePatch(current, fp);
      if (next === null) throw new Error(`the diff does not apply in reverse to ${source ?? target}`);
      fs.mkdirSync(path.dirname(path.join(tmp, target)), { recursive: true });
      fs.writeFileSync(path.join(tmp, target), next);
    }
    linkNodeModules(abs, tmp);
    return rebase(buildDir(tmp, abs, options), abs);
  } finally {
    removeLink(path.join(tmp, "node_modules"));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
