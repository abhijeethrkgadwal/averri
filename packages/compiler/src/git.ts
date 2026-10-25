/**
 * Minimal git access (never required): HEAD commit, dirty flag, diffs, file contents at a ref, and a
 * temporary worktree for building another revision. Every function degrades to null/false outside git.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function git(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer });
  } catch {
    return null;
  }
}

export function gitTopLevel(root: string): string | null {
  const out = git(root, ["rev-parse", "--show-toplevel"]);
  return out ? path.resolve(out.trim()) : null;
}

export function gitHead(root: string): string | null {
  const out = git(root, ["rev-parse", "HEAD"]);
  return out ? out.trim() : null;
}

/** True when the working tree under `root` differs from HEAD (tracked changes or untracked files). */
export function gitDirty(root: string): boolean {
  const out = git(root, ["status", "--porcelain", "--", "."]);
  return out !== null && out.trim().length > 0;
}

export function gitInfo(root: string): { commit: string | null; dirty: boolean } {
  const commit = gitHead(root);
  return { commit, dirty: commit ? gitDirty(root) : false };
}

/** Unified diff of the working tree against `base` (default HEAD), paths relative to `root`. */
export function gitDiff(root: string, base = "HEAD"): string | null {
  return git(root, ["diff", "--relative", "--no-color", "--no-ext-diff", base, "--", "."]);
}

/** Changed files between `base` and `head` (or the working tree), relative to root. */
export function gitChangedFiles(root: string, base = "HEAD", head?: string): string[] {
  const args = head ? ["diff", "--relative", "--name-only", base, head, "--", "."] : ["diff", "--relative", "--name-only", base, "--", "."];
  const out = git(root, args);
  const untracked = head ? null : git(root, ["ls-files", "--others", "--exclude-standard", "--", "."]);
  return [...(out ?? "").split("\n"), ...(untracked ?? "").split("\n")].map((s) => s.trim()).filter(Boolean);
}

export function gitLogFile(root: string, file: string, limit = 20): Array<{ commit: string; at: string; author: string }> {
  const out = git(root, ["log", `-n${limit}`, "--format=%H%x09%cI%x09%an", "--", file]);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [commit, at, author] = l.split("\t");
      return { commit: commit ?? "", at: at ?? "", author: author ?? "" };
    });
}

/** `git blame` author of one line, or null. */
export function gitBlameAuthor(root: string, file: string, line: number): string | null {
  const out = git(root, ["blame", "-L", `${line},${line}`, "--porcelain", "--", file]);
  const m = out ? /^author (.+)$/m.exec(out) : null;
  return m ? (m[1] as string) : null;
}

/**
 * Check out `ref` into a temporary worktree and return the path of `root` inside it, with a
 * `node_modules` junction to the nearest ancestor `node_modules` so type information resolves.
 * `dispose()` removes the worktree.
 */
export function gitWorktreeAt(root: string, ref: string): { dir: string; dispose(): void } | null {
  const top = gitTopLevel(root);
  if (!top) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "averri-wt-"));
  const wt = path.join(tmp, "tree");
  if (git(top, ["worktree", "add", "--detach", "--force", wt, ref]) === null) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  }
  const rel = path.relative(top, root);
  const dir = path.join(wt, rel);
  linkNodeModules(root, dir);
  return {
    dir,
    dispose() {
      removeLink(path.join(dir, "node_modules"));
      git(top, ["worktree", "remove", "--force", wt]);
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Remove a symlink/junction WITHOUT touching its target (never recurse through a link into the real
 * node_modules).
 */
export function removeLink(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

/** Junction `<dir>/node_modules` to the nearest `node_modules` above `from` (best effort). */
export function linkNodeModules(from: string, dir: string): void {
  let cur = path.resolve(from);
  for (;;) {
    const nm = path.join(cur, "node_modules");
    if (fs.existsSync(nm)) {
      const target = path.join(dir, "node_modules");
      if (!fs.existsSync(target)) {
        try {
          fs.symlinkSync(nm, target, process.platform === "win32" ? "junction" : "dir");
        } catch {
          /* type information will be partial */
        }
      }
      return;
    }
    const up = path.dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}
