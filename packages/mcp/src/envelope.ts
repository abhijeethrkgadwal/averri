/**
 * Response envelope (SPEC-MCP §3) and the shared token-budget helper (§9). Budgets are measured as
 * `ceil(chars / 4)` of the serialised response: envelope fields, `more` (capped) and `data` (D-41d).
 */

import { capMore, responseTokens } from "@averri/compiler";
import type { Diagnostic, Graph } from "@averri/ir";

export interface Envelope<T> {
  ok: true;
  commit: string | null;
  dirty: boolean;
  builtAt: string;
  stale: false;
  rebuilt: boolean;
  truncated: boolean;
  more?: string[];
  data: T;
}

export type ToolErrorCode = "build-failed" | "not-found" | "ambiguous" | "low-confidence" | "bad-input";

export interface ToolError {
  ok: false;
  error: ToolErrorCode;
  message: string;
  diagnostics?: Diagnostic[];
  candidates?: string[];
}

export type ToolResponse<T> = Envelope<T> | ToolError;

/** What a tool body returns before the envelope is added. */
export type Outcome<T> = { ok: true; data: T; truncated: boolean; more?: string[] } | (Omit<ToolError, "error"> & { error: Exclude<ToolErrorCode, "build-failed"> });

export function tokensOf(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function envelope<T>(graph: Graph, rebuilt: boolean, r: { data: T; truncated: boolean; more?: string[] }): Envelope<T> {
  const out: Envelope<T> = {
    ok: true,
    commit: graph.meta.commit,
    dirty: graph.meta.dirty,
    builtAt: graph.meta.builtAt,
    stale: false,
    rebuilt,
    truncated: r.truncated,
    data: r.data,
  };
  if (r.more && r.more.length > 0) out.more = r.more;
  return out;
}

export function toolError(error: ToolErrorCode, message: string, extra: { candidates?: string[]; diagnostics?: Diagnostic[] } = {}): ToolError {
  const e: ToolError = { ok: false, error, message };
  if (extra.candidates) e.candidates = extra.candidates;
  if (extra.diagnostics) e.diagnostics = extra.diagnostics;
  return e;
}

/** The exact text the MCP server sends and `averri <tool> --json` prints. */
export function serialize(result: ToolResponse<unknown>): string {
  return JSON.stringify(result);
}

export interface DropStep<T> {
  /** The list inside `data` to shorten (items are removed from the end). */
  list: (data: T) => unknown[];
  /** Handle returned in `more` for a removed item. */
  handle?: (item: never) => string;
  /** Items that are never removed. Default 0. */
  keep?: number;
}

/**
 * Remove list items from the end, step by step in the documented drop order, until `data` fits the
 * budget. Works on a structured clone; returns `truncated` and the removed items' handles (capped, so
 * `more` cannot grow past what the budget measured).
 */
export function bound<T>(data: T, budget: number, steps: ReadonlyArray<DropStep<T>>): { data: T; truncated: boolean; more?: string[] } {
  const copy = structuredClone(data);
  const more: string[] = [];
  let truncated = false;
  for (const step of steps) {
    const list = step.list(copy);
    while (responseTokens(copy, more) > budget && list.length > (step.keep ?? 0)) {
      const item = list.pop();
      truncated = true;
      if (step.handle) more.unshift(step.handle(item as never));
    }
    if (responseTokens(copy, more) <= budget) break;
  }
  return more.length > 0 ? { data: copy, truncated, more: capMore(more) } : { data: copy, truncated };
}
