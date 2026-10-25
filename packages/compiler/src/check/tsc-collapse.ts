/**
 * Cascade collapse for the tsc backstop (SPEC-DIAGNOSTICS §5) — a DIFF-SCOPED HEURISTIC, not
 * root-cause analysis:
 * 1. symbols introduced, renamed or removed in the diff since last green (or `diffBase`);
 * 2. each tsc error whose message names one of them (`'x'`) joins that symbol's group;
 * 3. one A9001 per group (title = first error, node = the declaration holding the symbol, cause[0] =
 *    the hunk, message "+N more errors reference 'x'");
 * 4. TS2769 on a `@averri/core` constructor call: title = the useful overload-detail line;
 * 5. ungrouped errors one each up to 10, the rest summarised as "N more TypeScript errors".
 */

import type { Diagnostic, Graph, GraphDiff, NodeId } from "@averri/ir";
import { emit } from "../diagnostics.js";
import { parseUnifiedDiff } from "../patch.js";
import type { TscError } from "./tsc.js";

export interface DiffSymbol {
  name: string;
  /** "+" introduced, "-" removed, "~" renamed/changed. */
  change: "+" | "-" | "~";
  file: string | null;
  line: number;
  /** Declaration node containing the symbol's definition, when known. */
  node: NodeId | null;
}

const DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const PROP_RE = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(]/;
const PRISMA_FIELD_RE = /^([A-Za-z_]\w*)\s+[A-Z][\w]*(\[\])?\??(\s|$)/;
const CORE_CONSTRUCTORS = ["entity", "policy", "action", "query", "event", "workflow", "integration", "defineConfig"];

/** Symbols named on added/removed lines of a unified diff, plus Field/declaration names from a GraphDiff. */
export function diffSymbols(unifiedDiff: string | null, graph: Graph | null, graphDiff: GraphDiff | null = null): DiffSymbol[] {
  const out = new Map<string, DiffSymbol>();
  const add = (s: DiffSymbol): void => {
    const prev = out.get(s.name);
    if (!prev) out.set(s.name, s);
    else if (prev.change !== s.change) out.set(s.name, { ...prev, change: "~", node: prev.node ?? s.node });
  };
  if (unifiedDiff) {
    for (const f of parseUnifiedDiff(unifiedDiff)) {
      const file = f.newFile ?? f.oldFile;
      const isPrisma = !!file && file.endsWith(".prisma");
      for (const h of f.hunks) {
        let newLine = h.newStart;
        let oldLine = h.oldStart;
        for (const l of h.lines) {
          if (l.startsWith("\\")) continue;
          const tag = l[0];
          const body = l.slice(1).trim();
          if (tag === "+" || tag === "-") {
            const m = DECL_RE.exec(body) ?? (isPrisma ? PRISMA_FIELD_RE.exec(body) : PROP_RE.exec(body));
            if (m && m[1]) {
              const line = tag === "+" ? newLine : oldLine;
              add({ name: m[1], change: tag, file, line, node: graph && file ? nodeAt(graph, file, line) : null });
            }
          }
          if (tag !== "-") newLine++;
          if (tag !== "+") oldLine++;
        }
      }
    }
  }
  if (graphDiff) {
    for (const op of graphDiff.ops) {
      if (op.op !== "add" && op.op !== "remove" && op.op !== "rename") continue;
      const id = op.node;
      const q = id.slice(id.indexOf(":") + 1);
      const name = id.startsWith("Field:") ? q.slice(q.indexOf(".") + 1) : q.slice(q.lastIndexOf(".") + 1);
      add({ name, change: op.op === "add" ? "+" : op.op === "remove" ? "-" : "~", file: null, line: 0, node: id });
      if (op.op === "rename" && op.target) {
        const t = op.target;
        const tq = t.slice(t.indexOf(":") + 1);
        add({ name: tq.slice(tq.lastIndexOf(".") + 1), change: "~", file: null, line: 0, node: id });
      }
    }
  }
  return [...out.values()];
}

/** Smallest declared/extracted node whose src span contains `file:line`. */
export function nodeAt(graph: Graph, file: string, line: number): NodeId | null {
  let best: { id: NodeId; span: number } | null = null;
  for (const n of Object.values(graph.nodes)) {
    if (!n.src || n.src.file !== file || n.kind === "Module") continue;
    const [s, e] = [n.src.range[0][0], n.src.range[1][0]];
    if (line < s || line > e) continue;
    const span = e - s;
    if (!best || span < best.span) best = { id: n.id, span };
  }
  if (best) return best.id;
  return graph.nodes[`Module:${file}` as NodeId] ? (`Module:${file}` as NodeId) : null;
}

function trim80(s: string): string {
  const one = s.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  return one.length <= 80 ? one : `${one.slice(0, 77)}...`;
}

/** Title for TS2769 on a core constructor: the first known-property / missing-property line. */
export function usefulTitle(e: TscError, lineText: string | null): string {
  if (e.code === 2769 && lineText && CORE_CONSTRUCTORS.some((c) => new RegExp(`\\b${c}\\s*\\(`).test(lineText))) {
    const useful = e.message.split("\n").map((l) => l.trim()).find((l) => /^Object literal may only specify known properties/.test(l) || /^Property '.+' is missing/.test(l));
    if (useful) return trim80(useful);
  }
  return trim80(e.message);
}

export interface CollapseOptions {
  graph: Graph | null;
  symbols: DiffSymbol[];
  /** Text of a file line (for TS2769 detection), when available. */
  lineText?: (file: string, line: number) => string | null;
  maxUngrouped?: number;
}

export function collapseTscErrors(errors: readonly TscError[], options: CollapseOptions): Diagnostic[] {
  const maxUngrouped = options.maxUngrouped ?? 10;
  const symbols = new Map(options.symbols.map((s) => [s.name, s]));
  const groups = new Map<string, TscError[]>();
  const ungrouped: TscError[] = [];
  const sorted = [...errors].sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.line - b.line || a.column - b.column || a.code - b.code);
  for (const e of sorted) {
    const quoted = [...e.message.matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((m) => m[1] as string);
    const sym = quoted.find((q) => symbols.has(q));
    if (sym) groups.set(sym, [...(groups.get(sym) ?? []), e]);
    else ungrouped.push(e);
  }
  const out: Diagnostic[] = [];
  const srcOf = (e: TscError) => (e.file ? { file: e.file, range: [[e.line, e.column], [e.line, e.column]] as [[number, number], [number, number]] } : null);
  for (const [name, errs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = errs[0] as TscError;
    const sym = symbols.get(name) as DiffSymbol;
    const node = sym.node ?? (options.graph && first.file ? nodeAt(options.graph, first.file, first.line) : null);
    const verb = sym.change === "+" ? "introduced" : sym.change === "-" ? "removed" : "changed";
    const hunk = sym.file ? `${sym.file}:${sym.line}` : "the graph diff";
    out.push(
      emit("A9001", {
        title: usefulTitle(first, first.file && options.lineText ? options.lineText(first.file, first.line) : null),
        node,
        src: srcOf(first),
        message: errs.length > 1 ? `+${errs.length - 1} more errors reference '${name}'` : `1 error references '${name}'`,
        cause: node ? [{ node, why: `the diff ${verb} '${name}' at ${hunk}` }] : [],
      }),
    );
  }
  for (const e of ungrouped.slice(0, maxUngrouped)) {
    const node = options.graph && e.file ? nodeAt(options.graph, e.file, e.line) : null;
    out.push(
      emit("A9001", {
        title: usefulTitle(e, e.file && options.lineText ? options.lineText(e.file, e.line) : null),
        node,
        src: srcOf(e),
        message: `TS${e.code}`,
        cause: node ? [{ node, why: `TS${e.code} at ${e.file}:${e.line}` }] : [],
      }),
    );
  }
  const rest = ungrouped.length - maxUngrouped;
  if (rest > 0) {
    const files = Array.from(new Set(ungrouped.slice(maxUngrouped).map((e) => e.file ?? "?"))).slice(0, 5);
    out.push(emit("A9001", { title: `${rest} more TypeScript errors`, node: null, src: null, message: `in ${files.join(", ")}`, cause: [] }));
  }
  return out;
}
