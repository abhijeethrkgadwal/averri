/**
 * `averri fmt`: put the option keys of `entity/policy/event/action/query/workflow/integration(...)`
 * declarations into canonical order (`CANONICAL_KEY_ORDERS`, SPEC-DECLARATIONS §4) using ts-morph.
 * Purely textual per property: each property keeps its own text and leading comments and only moves.
 * Objects with spreads, computed or shorthand-less oddities are skipped and reported. Idempotent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CANONICAL_KEY_ORDERS } from "@averri/compiler";
import { Node, Project, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from "ts-morph";

const CONSTRUCTS = ["entity", "policy", "action", "query", "event", "workflow", "integration"] as const;
type Construct = (typeof CONSTRUCTS)[number];
const CORE = "@averri/core";

export interface FmtChange {
  file: string;
  line: number;
  construct: Construct;
  /** Option keys before and after. */
  before: string[];
  after: string[];
}

export interface FmtSkip {
  file: string;
  line: number;
  construct: Construct;
  reason: string;
}

export interface FmtFileResult {
  file: string;
  changes: FmtChange[];
  /** Formatted text when any change was made. */
  output: string | null;
}

export interface FmtResult {
  checked: number;
  changed: string[];
  changes: FmtChange[];
  skipped: FmtSkip[];
  written: boolean;
}

function slotOf(order: readonly string[], key: string): number {
  return order.findIndex((slot) => slot.split("|").includes(key));
}

function constructBindings(sf: SourceFile): { named: Map<string, Construct>; namespaces: Set<string> } {
  const named = new Map<string, Construct>();
  const namespaces = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== CORE || imp.isTypeOnly()) continue;
    const ns = imp.getNamespaceImport();
    if (ns) namespaces.add(ns.getText());
    for (const spec of imp.getNamedImports()) {
      const imported = spec.getNameNode().getText();
      if ((CONSTRUCTS as readonly string[]).includes(imported)) named.set(spec.getAliasNode()?.getText() ?? imported, imported as Construct);
    }
  }
  return { named, namespaces };
}

function constructOf(call: Node, b: ReturnType<typeof constructBindings>): Construct | null {
  if (!Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return b.named.get(callee.getText()) ?? null;
  if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression()) && b.namespaces.has(callee.getExpression().getText())) {
    const n = callee.getName();
    return (CONSTRUCTS as readonly string[]).includes(n) ? (n as Construct) : null;
  }
  return null;
}

function keyOf(p: Node): string | null {
  if (Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) || Node.isShorthandPropertyAssignment(p)) {
    const n = p.getNameNode();
    if (Node.isIdentifier(n)) return n.getText();
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
    return null;
  }
  return null;
}

/** New order of `keys`: known keys by slot; unknown keys stay behind the key that preceded them. */
export function canonicalKeyOrder(construct: Construct, keys: readonly string[]): string[] {
  const order = CANONICAL_KEY_ORDERS[construct];
  let prev = -1;
  const ranked = keys.map((key, i) => {
    const s = slotOf(order, key);
    if (s >= 0) prev = s;
    return { key, rank: s >= 0 ? s : prev, i };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return ranked.map((r) => r.key);
}

function optionsObject(call: Node): ObjectLiteralExpression | null {
  if (!Node.isCallExpression(call)) return null;
  const args = call.getArguments();
  const last = args[args.length - 1];
  return last && Node.isObjectLiteralExpression(last) ? last : null;
}

/** Format one parsed source file. Edits are applied back to front on the original text. */
export function formatSourceFile(sf: SourceFile, rel: string, skipped: FmtSkip[] = []): FmtFileResult {
  const bindings = constructBindings(sf);
  const result: FmtFileResult = { file: rel, changes: [], output: null };
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) return result;
  const text = sf.getFullText();
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const construct = constructOf(call, bindings);
    if (!construct) continue;
    const obj = optionsObject(call);
    if (!obj) continue;
    const line = call.getStartLineNumber();
    const props = obj.getProperties();
    if (props.length < 2) continue;
    const keys: string[] = [];
    let ok = true;
    for (const p of props) {
      const k = Node.isSpreadAssignment(p) ? null : keyOf(p);
      if (k === null) {
        ok = false;
        skipped.push({ file: rel, line, construct, reason: Node.isSpreadAssignment(p) ? "contains a spread" : "contains a computed or unsupported key" });
        break;
      }
      keys.push(k);
    }
    if (!ok) continue;
    if (new Set(keys).size !== keys.length) {
      skipped.push({ file: rel, line, construct, reason: "contains duplicate keys" });
      continue;
    }
    const next = canonicalKeyOrder(construct, keys);
    if (next.every((k, i) => k === keys[i])) continue;
    const pieces = new Map(props.map((p, i) => [keys[i] as string, text.slice(p.getFullStart(), p.getEnd())]));
    const start = props[0]?.getFullStart() as number;
    const end = props[props.length - 1]?.getEnd() as number;
    edits.push({ start, end, text: next.map((k) => pieces.get(k) as string).join(",") });
    result.changes.push({ file: rel, line, construct, before: keys, after: next });
  }
  if (edits.length === 0) return result;
  // Nested declarations (a construct inside an options object) overlap their parent: apply only outermost edits.
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof edits = [];
  for (const e of edits) {
    const last = kept[kept.length - 1];
    if (last && e.start < last.end) continue;
    kept.push(e);
  }
  let out = text;
  for (const e of [...kept].reverse()) out = `${out.slice(0, e.start)}${e.text}${out.slice(e.end)}`;
  result.output = out;
  return result;
}

export interface FmtOptions {
  /** Report only; write nothing. */
  check?: boolean;
  /** Source roots to scan (repo-relative). Default `["src"]`. */
  sourceRoots?: string[];
  /** Explicit files (repo-relative); overrides source roots. */
  files?: string[];
}

function listFiles(root: string, roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".averri" || e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.gen\.test\.ts$/.test(e.name)) out.push(abs);
    }
  };
  for (const r of roots) walk(path.join(root, r));
  return out.sort();
}

export function fmt(root: string, options: FmtOptions = {}): FmtResult {
  const files = options.files ? options.files.map((f) => path.join(root, f)) : listFiles(root, options.sourceRoots ?? ["src"]);
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: false } });
  const result: FmtResult = { checked: 0, changed: [], changes: [], skipped: [], written: false };
  for (const abs of files) {
    const text = fs.readFileSync(abs, "utf8");
    if (!text.includes(CORE)) continue;
    result.checked++;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const sf = project.createSourceFile(abs, text, { overwrite: true });
    const r = formatSourceFile(sf, rel, result.skipped);
    if (r.output === null) continue;
    result.changed.push(rel);
    result.changes.push(...r.changes);
    if (!options.check) {
      fs.writeFileSync(abs, r.output);
      result.written = true;
    }
  }
  return result;
}
