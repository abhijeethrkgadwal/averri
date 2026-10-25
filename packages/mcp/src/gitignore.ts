/**
 * A small .gitignore matcher (no dependency): per-directory `.gitignore` files from the project root
 * down to the file, last matching pattern wins, an ignored ancestor directory ignores everything below
 * it. Supports `#`, `!`, leading/trailing `/`, `*`, `**`, `?`. Character classes are not supported.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface Rule {
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
}

function escapeChar(c: string): string {
  return ".+^${}()|[]\\".includes(c) ? `\\${c}` : c;
}

function globToRegex(glob: string, anchored: boolean): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "\\" && i + 1 < glob.length) out += escapeChar(glob[++i] as string);
    else out += escapeChar(c);
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${out}$`);
}

export function parseGitignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (line === "") continue;
    rules.push({ negate, dirOnly, re: globToRegex(line, anchored) });
  }
  return rules;
}

function decide(rules: Rule[], rel: string, isDir: boolean): boolean | null {
  let result: boolean | null = null;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) result = !r.negate;
  }
  return result;
}

/** True when `relPosix` (relative to `root`, no leading `./`) is ignored. `isDir` is for the leaf. */
export function isIgnored(root: string, relPosix: string, isDir: boolean): boolean {
  const segs = relPosix.split("/").filter(Boolean);
  const cache = new Map<string, Rule[]>();
  const rulesAt = (dirRel: string): Rule[] => {
    let r = cache.get(dirRel);
    if (!r) {
      const file = path.join(root, dirRel, ".gitignore");
      r = fs.existsSync(file) ? parseGitignore(fs.readFileSync(file, "utf8")) : [];
      cache.set(dirRel, r);
    }
    return r;
  };
  for (let i = 1; i <= segs.length; i++) {
    const leaf = i === segs.length;
    const rel = segs.slice(0, i).join("/");
    const dirFlag = leaf ? isDir : true;
    if (segs[i - 1] === ".git" || segs[i - 1] === "node_modules") return true;
    let verdict: boolean | null = null;
    for (let d = 0; d < i; d++) {
      const dirRel = segs.slice(0, d).join("/");
      const sub = segs.slice(d, i).join("/");
      const v = decide(rulesAt(dirRel), sub, dirFlag);
      if (v !== null) verdict = v;
    }
    if (verdict === true) return true;
  }
  return false;
}
