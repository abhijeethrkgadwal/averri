/**
 * `suggest` (SPEC-MCP §6.8): drafts observe-mode declarations as unified diffs. Never applies anything.
 * Heuristics are deliberately small: route and input from the Exposure, policy reused from sibling
 * Exposures of the same router file when >= 2 share one, `requires` from `if (...) throw/return 4xx`
 * patterns of a few recognisable shapes, `intent` left as a TODO.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { makePatch, resolveNodeId } from "@averri/compiler";
import type { ActionNode, ExposureNode, Graph, Node, NodeId, PolicyNode, QueryNode, SourceRange } from "@averri/ir";
import { z } from "zod";
import { defineTool } from "../define.js";
import { bound, type Outcome } from "../envelope.js";

export const SUGGEST_BUDGET = 2000;

export const inputSchema = z.object({ id: z.string().optional() });

export interface Proposal {
  target: NodeId;
  patch: string;
  evidence: string[];
}

type Need = [module: string, name: string];

const KEY_ORDER = ["intent", "route", "input", "output", "policy", "public", "subject", "requires", "ensures", "effects", "idempotency", "transaction", "run", "handler", "owner", "tags"];
const WRITE_RE = /\.\w+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;

const posix = (p: string): string => p.split(path.sep).join("/");
const pascal = (s: string): string => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _sep, c: string) => c.toUpperCase());
const camel = (s: string): string => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
const singular = (s: string): string => (s.endsWith("ies") ? `${s.slice(0, -3)}y` : s.endsWith("ses") ? s.slice(0, -2) : s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);
const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Virtual file store so that several proposals for one file apply in order. */
class Files {
  private readonly content = new Map<string, string>();
  constructor(private readonly root: string) {}
  get(rel: string): string {
    let c = this.content.get(rel);
    if (c === undefined) {
      const abs = path.join(this.root, rel);
      c = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n") : "";
      this.content.set(rel, c);
    }
    return c;
  }
  set(rel: string, text: string): void {
    this.content.set(rel, text);
  }
}

/** Add `import { name } from "module"` for each need not already imported; extends an existing import of the module. */
function ensureImports(text: string, needs: readonly Need[]): string {
  let out = text;
  for (const [mod, name] of needs) {
    const named = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${escapeRe(name)}\\b[^}]*\\}\\s*from\\s*["']${escapeRe(mod)}["']`);
    if (named.test(out)) continue;
    const same = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escapeRe(mod)}["']`).exec(out);
    if (same) {
      out = out.replace(same[0], `import {${(same[1] as string).replace(/\s*$/, "")}, ${name} } from "${mod}"`);
      continue;
    }
    const lines = out.split("\n");
    let at = 0;
    lines.forEach((l, i) => {
      if (/^import\s/.test(l) || /^}\s*from\s/.test(l)) at = i + 1;
    });
    lines.splice(at, 0, `import { ${name} } from "${mod}";`);
    out = lines.join("\n");
  }
  return out;
}

function relImport(fromFile: string, toFile: string): string {
  let rel = posix(path.relative(path.dirname(fromFile), toFile)).replace(/\.(ts|tsx|mts|cts)$/, ".js");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function readText(root: string, file: string): string | null {
  const abs = path.join(root, file);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n") : null;
}

// ---------------------------------------------------------------- handler analysis

function balanced(text: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
  }
  return -1;
}

const REF_PATTERNS: Array<[RegExp, "input" | "actor"]> = [
  [/^(?:body|input|data|payload|parsed|params|param|query|req\.body|req\.params|req\.query)\.(\w+)$/, "input"],
  [/^c\.req\.param\(\s*["'](\w+)["']\s*\)$/, "input"],
  [/^c\.req\.valid\(\s*["']\w+["']\s*\)\.(\w+)$/, "input"],
  [/^(?:user|actor|auth|currentUser|req\.user)\.(\w+)$/, "actor"],
  [/^c\.get\(\s*["'](?:user|actor)["']\s*\)\.(\w+)$/, "actor"],
];

function refOf(expr: string): { root: "input" | "actor"; field: string } | null {
  const t = expr.trim();
  for (const [re, root] of REF_PATTERNS) {
    const m = re.exec(t);
    if (m) return { root, field: m[1] as string };
  }
  return null;
}

function literalOf(expr: string): string | null {
  const t = expr.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) || t === "true" || t === "false" || t === "null") return t;
  const m = /^(["'])((?:(?!\1).)*)\1$/.exec(t);
  return m ? JSON.stringify(m[2]) : null;
}

function operandSource(expr: string): string | null {
  const r = refOf(expr);
  return r ? `e.${r.root}(${JSON.stringify(r.field)})` : literalOf(expr);
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function whereSource(obj: string): string | null {
  const inner = obj.trim().replace(/^\{/, "").replace(/\}$/, "");
  const pairs: string[] = [];
  for (const part of splitTopLevel(inner)) {
    const m = /^\s*(["']?)([\w$]+)\1\s*:\s*([\s\S]+)$/.exec(part);
    if (!m) return null;
    const v = operandSource(m[3] as string);
    if (!v) return null;
    pairs.push(`${key(m[2] as string)}: ${v}`);
  }
  return pairs.length > 0 ? `{ ${pairs.join(", ")} }` : null;
}

const NEGATED: Record<string, string> = { "===": "ne", "==": "ne", "!==": "eq", "!=": "eq", ">": "lte", ">=": "lt", "<": "gte", "<=": "gt" };

export interface ClauseDraft {
  name: string;
  source: string;
  needs: Need[];
  evidence: string;
}

export function draftRequires(handlerText: string, file: string, firstLine: number): ClauseDraft[] {
  const drafts: ClauseDraft[] = [];
  const names = new Set<string>();
  const unique = (base: string): string => {
    let n = base;
    for (let i = 2; names.has(n); i++) n = `${base}${i}`;
    names.add(n);
    return n;
  };
  const re = /\bif\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(handlerText))) {
    const open = m.index + m[0].length - 1;
    const close = balanced(handlerText, open, "(", ")");
    if (close < 0) continue;
    const cond = handlerText.slice(open + 1, close).trim();
    const rest = handlerText.slice(close + 1);
    const trimmed = rest.trimStart();
    let block: string;
    if (trimmed.startsWith("{")) {
      const start = rest.length - trimmed.length;
      const end = balanced(rest, start, "{", "}");
      block = end < 0 ? rest.slice(start) : rest.slice(start, end + 1);
    } else block = rest.split(";")[0] ?? "";
    if (!/\b(?:throw|return)\b/.test(block) || !/\b4\d\d\b/.test(block)) continue;
    if (/&&|\|\|/.test(cond)) continue;
    const line = firstLine + handlerText.slice(0, m.index).split("\n").length - 1;
    const where = `${file}:${line}`;
    const shown = cond.replace(/\s+/g, " ");

    let c = cond;
    let neg = false;
    for (;;) {
      const t = c.trim();
      if (t.startsWith("!") && !t.startsWith("!=")) {
        neg = !neg;
        c = t.slice(1);
      } else if (t.startsWith("(") && balanced(t, 0, "(", ")") === t.length - 1) c = t.slice(1, -1);
      else break;
    }
    c = c.trim().replace(/^await\s+/, "").replace(/\s+/g, " ");
    const find = /^([\w.$]+)\.(\w+)\.(findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count)\(\s*\{\s*where\s*:\s*(\{[^}]*\})\s*\}?\s*\)(?:\s*(>|===|!==|>=|==)\s*(\d+))?$/.exec(c);
    if (find) {
      const model = find[2] as string;
      const w = whereSource(find[4] as string);
      if (!w) continue;
      let failsWhenRowExists: boolean;
      if (find[3] === "count") {
        const op = find[5];
        const n = Number(find[6]);
        if ((op === ">" && n === 0) || (op === ">=" && n === 1)) failsWhenRowExists = !neg;
        else if ((op === "===" || op === "==") && n === 0) failsWhenRowExists = neg;
        else continue;
      } else failsWhenRowExists = !neg;
      const fn = failsWhenRowExists ? "none" : "exists";
      drafts.push({
        name: unique(failsWhenRowExists ? `no${pascal(model)}Match` : `${camel(model)}Exists`),
        source: `db.${fn}(${JSON.stringify(model)}, ${w})`,
        needs: [["@averri/core", "db"]],
        evidence: `${where}: if (${shown}) -> 4xx, drafted as db.${fn}`,
      });
      continue;
    }
    const cmp = /^([\w.$()"']+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/.exec(c);
    if (cmp && !neg) {
      const lhs = refOf(cmp[1] as string);
      const rhs = literalOf(cmp[3] as string);
      const op = NEGATED[cmp[2] as string];
      if (lhs && rhs && op) {
        drafts.push({
          name: unique(`${camel(lhs.field)}Valid`),
          source: `e.${op}(${JSON.stringify(`${lhs.root}.${lhs.field}`)}, ${rhs})`,
          needs: [["@averri/core", "e"]],
          evidence: `${where}: if (${shown}) -> 4xx, drafted as e.${op}`,
        });
      }
    }
  }
  return drafts;
}

function countWrites(text: string): number {
  return (text.match(WRITE_RE) ?? []).length;
}

function handlerInfo(root: string, x: { handler: { file: string; range?: SourceRange } | null }): { text: string; file: string; line: number } | null {
  const h = x.handler;
  if (!h) return null;
  const whole = readText(root, h.file);
  if (whole === null) return null;
  if (!h.range) return { text: whole, file: h.file, line: 1 };
  return { text: whole.split("\n").slice(h.range.range[0][0] - 1, h.range.range[1][0]).join("\n"), file: h.file, line: h.range.range[0][0] };
}

// ---------------------------------------------------------------- ids and policies

function deriveId(graph: Graph, x: ExposureNode): { id: string; isQuery: boolean } {
  const segs = x.path.split("/").filter((s) => s !== "");
  const lit = segs.filter((s) => !s.startsWith(":") && !s.startsWith("*"));
  const scope = pascal(singular(lit[0] ?? "Root"));
  const lastIsParam = segs.length > 0 && (segs[segs.length - 1] as string).startsWith(":");
  const isQuery = x.method === "GET";
  const sub = lit.length > 1 ? pascal(singular(lit[lit.length - 1] as string)) : "";
  let verb: string;
  if (isQuery) verb = lastIsParam ? "get" : "list";
  else if (x.method === "POST") verb = "create";
  else if (x.method === "DELETE") verb = "delete";
  else verb = "update";
  const base = verb + sub;
  let name = base;
  for (let i = 2; graph.nodes[`Action:${scope}.${name}` as NodeId] || graph.nodes[`Query:${scope}.${name}` as NodeId]; i++) name = `${base}${i}`;
  return { id: `${scope}.${name}`, isQuery };
}

function exportName(root: string, node: Node | undefined): string | null {
  if (!node?.src) return null;
  const text = readText(root, node.src.file);
  if (!text) return null;
  const line = text.split("\n")[node.src.range[0][0] - 1] ?? "";
  const m = /export\s+const\s+(\w+)/.exec(line);
  return m ? (m[1] as string) : null;
}

function siblingPolicy(graph: Graph, x: ExposureNode): PolicyNode | null {
  const file = x.src?.file;
  if (!file) return null;
  const counts = new Map<string, number>();
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== "Exposure" || n.id === x.id || n.src?.file !== file) continue;
    const boundTo = (n as ExposureNode).boundTo;
    const decl = boundTo ? (graph.nodes[boundTo] as ActionNode | QueryNode | undefined) : undefined;
    if (decl?.policy) counts.set(decl.policy, (counts.get(decl.policy) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const [p, c] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (c >= 2 && (!best || c > best[1])) best = [p, c];
  return best ? ((graph.nodes[best[0] as NodeId] as PolicyNode | undefined) ?? null) : null;
}

// ---------------------------------------------------------------- drafting

function suggestForExposure(graph: Graph, root: string, files: Files, x: ExposureNode): Proposal {
  const evidence: string[] = [`${x.method} ${x.path} (${x.id}) has no declaration${x.src ? ` at ${x.src.file}:${x.src.range[0][0]}` : ""}`];
  if (x.provenance.origin === "extracted" && x.provenance.confidence < 0.9) {
    evidence.push(`verify: read ${x.src?.file ?? "the route"} first, ${x.provenance.evidence.map((e) => e.note).join("; ")}`);
  }
  const { id, isQuery } = deriveId(graph, x);
  const needs: Need[] = [["@averri/core", isQuery ? "query" : "action"]];
  const h = handlerInfo(root, x);
  const writes = h ? countWrites(h.text) : 0;
  evidence.push(`handler ${x.handler ? `${x.handler.file}:${x.handler.symbol}` : "not resolved"}, ${writes} Prisma write call(s)`);

  const baseFile = (x.handler?.file ?? x.src?.file ?? "src/routes.ts").replace(/\.(ts|tsx|mts|cts)$/, "");
  const target = `${baseFile}.averri.ts`;
  const lines: string[] = [];
  lines.push(`export const ${pascal(id)} = ${isQuery ? "query" : "action"}(${JSON.stringify(id)}, {`);
  lines.push(`  intent: "TODO: describe what ${x.method} ${x.path} does and who may call it.",`);
  lines.push(`  route: { method: ${JSON.stringify(x.method)}, path: ${JSON.stringify(x.path)} },`);

  if (x.bodySchema && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(x.bodySchema.symbol)) {
    needs.push([relImport(target, x.bodySchema.file), x.bodySchema.symbol.split(".")[0] as string]);
    lines.push(`  input: ${x.bodySchema.symbol},`);
    evidence.push(`input from Zod schema ${x.bodySchema.file}:${x.bodySchema.symbol}`);
  } else {
    const params = [...x.path.matchAll(/:(\w+)/g)].map((m) => m[1] as string);
    needs.push(["zod", "z"]);
    lines.push(params.length ? `  input: z.object({ ${params.map((p) => `${p}: z.string()`).join(", ")} }),` : "  input: z.object({}),");
    evidence.push(params.length ? `input from path params (${params.join(", ")}); no Zod schema detected` : "no Zod schema detected; empty input");
  }

  const sibling = siblingPolicy(graph, x);
  if (x.public) {
    lines.push("  public: true,");
    evidence.push("route is marked public");
  } else if (sibling) {
    const nm = exportName(root, sibling) ?? sibling.name.split(".").pop() ?? sibling.name;
    lines.push(`  policy: ${nm},`);
    if (sibling.src) needs.push([relImport(target, sibling.src.file), nm]);
    evidence.push(`policy ${sibling.id} reused: >= 2 sibling Exposures in ${x.src?.file} share it`);
  } else {
    lines.push("  // policy: TODO choose a policy() or set public: true (exactly one is required).");
    evidence.push("no policy suggested: fewer than 2 sibling Exposures share one");
  }

  if (!isQuery && h) {
    const drafts = draftRequires(h.text, h.file, h.line);
    if (drafts.length > 0) {
      lines.push("  requires: {");
      for (const d of drafts) {
        lines.push(`    ${d.name}: ${d.source},`);
        evidence.push(d.evidence);
        needs.push(...d.needs);
      }
      lines.push("  },");
    } else evidence.push("no recognisable `if (...) throw/return 4xx` pattern in the handler; no requires drafted");
  }
  if (!isQuery) lines.push(`  effects: [${writes > 0 ? '"db:write"' : '"db:read"'}],`);
  const hs = x.handler?.symbol;
  if (hs && x.handler && IDENT.test(hs) && new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${hs}\\b`).test(readText(root, x.handler.file) ?? "")) {
    needs.push([relImport(target, x.handler.file), hs]);
    lines.push(`  handler: ${hs},`);
  }
  lines.push("});");

  const before = files.get(target);
  let after = before === "" ? "" : `${before.replace(/\n*$/, "")}\n\n`;
  after += `${lines.join("\n")}\n`;
  after = ensureImports(after, needs);
  if (before === "") after = after.replace(/^((?:import [^\n]*\n)+)(export)/, "$1\n$2");
  files.set(target, after);
  evidence.push(before === "" ? `new file ${target} next to the handler module` : `appended to ${target}`);
  return { target: x.id, patch: makePatch(target, before, after) ?? "", evidence };
}

function suggestForDeclaration(root: string, files: Files, n: ActionNode | QueryNode): Proposal | { error: string } {
  const src = n.src;
  if (!src) return { error: `${n.id} has no source span` };
  const text = files.get(src.file);
  if (text === "") return { error: `cannot read ${src.file}` };
  const lines = text.split("\n");
  const first = src.range[0][0] - 1;
  const last = src.range[1][0] - 1;
  if (!/\{\s*$/.test(lines[first] ?? "") || !/^\s*\}/.test(lines[last] ?? "")) {
    return { error: `${n.id}: the declaration at ${src.file}:${first + 1} is not a plain object literal; edit it by hand` };
  }
  const ind = /^(\s*)\S/.exec(lines.slice(first + 1, last).find((l) => l.trim() !== "") ?? "")?.[1] ?? "  ";
  const evidence: string[] = [];
  const inserts: Array<{ at: number; lines: string[] }> = [];
  const needs: Need[] = [];
  if (!n.intent) {
    inserts.push({ at: first + 1, lines: [`${ind}intent: "TODO: describe what ${n.name} does and who may call it.",`] });
    evidence.push(`${n.id} has no intent`);
  }
  if (n.kind === "Action" && !n.contracts.some((c) => c.includes(".requires."))) {
    const h = handlerInfo(root, n);
    const drafts = h ? draftRequires(h.text, h.file, h.line) : [];
    if (drafts.length > 0) {
      let at = last;
      const mine = KEY_ORDER.indexOf("requires");
      for (let i = first + 1; i < last; i++) {
        const k = new RegExp(`^${ind}(\\w+)\\s*:`).exec(lines[i] as string);
        if (k && KEY_ORDER.indexOf(k[1] as string) > mine) {
          at = i;
          break;
        }
      }
      inserts.push({ at, lines: [`${ind}requires: {`, ...drafts.map((d) => `${ind}  ${d.name}: ${d.source},`), `${ind}},`] });
      for (const d of drafts) {
        evidence.push(d.evidence);
        needs.push(...d.needs);
      }
    }
  }
  if (inserts.length === 0) return { error: `${n.id}: nothing to draft (intent present, and requires present or no recognisable handler pattern)` };
  const out = [...lines];
  for (const ins of [...inserts].sort((a, b) => b.at - a.at)) out.splice(ins.at, 0, ...ins.lines);
  const after = ensureImports(out.join("\n"), needs);
  files.set(src.file, after);
  return { target: n.id, patch: makePatch(src.file, text, after) ?? "", evidence };
}

export function suggest(graph: Graph, root: string, input: { id?: string }): Outcome<{ proposals: Proposal[]; message?: string }> {
  const files = new Files(root);
  const proposals: Proposal[] = [];
  let message: string | undefined;
  if (input.id !== undefined) {
    const r = resolveNodeId(graph, input.id);
    if (!r.ok) return { ok: false, error: r.error, message: r.error === "ambiguous" ? `${input.id} matches several nodes` : `no node ${input.id}`, candidates: r.candidates };
    const n = graph.nodes[r.id] as Node;
    if (n.kind === "Exposure") {
      const x = n as ExposureNode;
      if (x.boundTo) return { ok: false, error: "bad-input", message: `${x.id} is already declared by ${x.boundTo}; pass that id to draft missing intent or contracts` };
      proposals.push(suggestForExposure(graph, root, files, x));
    } else if (n.kind === "Action" || n.kind === "Query") {
      const p = suggestForDeclaration(root, files, n as ActionNode | QueryNode);
      if ("error" in p) message = p.error;
      else proposals.push(p);
    } else return { ok: false, error: "bad-input", message: `suggest takes an Exposure, Action or Query id, not ${n.kind}` };
  } else {
    const ranked = Object.values(graph.nodes)
      .filter((n): n is ExposureNode => n.kind === "Exposure" && (n as ExposureNode).boundTo === null)
      .map((x) => {
        const h = handlerInfo(root, x);
        return { x, writes: h ? countWrites(h.text) : 0, depth: x.path.split("/").filter(Boolean).length };
      })
      .sort((a, b) => b.writes - a.writes || b.depth - a.depth || (a.x.id < b.x.id ? -1 : 1))
      .slice(0, 5);
    for (const u of ranked) proposals.push(suggestForExposure(graph, root, files, u.x));
    if (proposals.length === 0) message = "no undeclared exposures";
  }
  const b = bound({ proposals }, SUGGEST_BUDGET, [{ list: (d) => d.proposals, handle: (p: Proposal) => p.target, keep: 1 }]);
  return { ok: true, data: message ? { ...b.data, message } : b.data, truncated: b.truncated, ...(b.more ? { more: b.more } : {}) };
}

export const suggestTool = defineTool(
  "suggest",
  "Draft observe-mode declarations as unified diffs for undeclared exposures, or missing intent/requires for an Action. Never applied. Budget 2000 tokens.",
  inputSchema,
  ({ graph, input, ctx }) => suggest(graph, ctx.root, input),
);
