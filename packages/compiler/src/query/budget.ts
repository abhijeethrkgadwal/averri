/**
 * Token budgets (SPEC-MCP §1, §9): `ceil(chars / 4)` of the serialised JSON; truncation happens at
 * item boundaries, deterministically, and returns drill-down handles in `more`.
 */

import { tokensOf } from "../util.js";

export const BUDGETS = {
  overview: 1200,
  find: 800,
  inspect: 2000,
  impact: 1500,
  check: 2000,
  explain: 1500,
  read_source: 4000,
  suggest: 2000,
} as const;

export interface Bounded<T> {
  data: T;
  truncated: boolean;
  more?: string[];
}

export type QueryError = { ok: false; error: "not-found" | "ambiguous" | "low-confidence" | "bad-input"; message: string; candidates?: string[] };

export type QueryResult<T> = ({ ok: true } & Bounded<T>) | QueryError;

/** Fixed fields of the SPEC-MCP §3 envelope; their serialised size counts against every budget (D-41d). */
const ENVELOPE_PROTOTYPE = {
  ok: true,
  commit: "0".repeat(40),
  dirty: false,
  builtAt: "2026-01-01T00:00:00.000Z",
  stale: false,
  rebuilt: false,
  truncated: true,
};

/** Most `more` handles a response lists; the rest collapse into one "+N more" entry. */
export const MORE_CAP = 10;

/**
 * Caps a `more` list at {@link MORE_CAP}: the first MORE_CAP - 1 handles, then `+N more`. Handles
 * beyond the cap are recoverable through `find`/`impact`, and an unbounded `more` would otherwise
 * be the part of a response that no budget measured.
 */
export function capMore(more: readonly string[], cap = MORE_CAP): string[] {
  if (more.length <= cap) return [...more];
  return [...more.slice(0, cap - 1), `+${more.length - (cap - 1)} more`];
}

/**
 * Tokens of the response as the server sends it: the envelope fields, `more` and `data`
 * (SPEC-MCP §1 measures the serialised JSON, not just `data`). `more` is measured after
 * {@link capMore}, which is what callers return.
 */
export function responseTokens(data: unknown, more: readonly string[] = []): number {
  const capped = capMore(more);
  return tokensOf({ ...ENVELOPE_PROTOTYPE, ...(capped.length > 0 ? { more: capped } : {}), data });
}

export function fits(value: unknown, budget: number): boolean {
  return responseTokens(value) <= budget;
}

/**
 * Remove items from the end of `list` (mutating a shallow copy held by `holder[key]`) until `holder`
 * fits the budget or only `keep` items remain. Returns the handles of the removed items.
 */
export function trimList<H extends Record<string, unknown>, K extends keyof H>(
  holder: H,
  key: K,
  budget: number,
  handle: (item: H[K] extends Array<infer I> ? I : never) => string,
  keep = 0,
  measure: unknown = holder,
): string[] {
  const list = holder[key] as unknown as unknown[];
  const removed: string[] = [];
  while (responseTokens(measure, removed) > budget && list.length > keep) {
    const item = list.pop();
    removed.unshift(handle(item as never));
  }
  return removed;
}
