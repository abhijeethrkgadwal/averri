/**
 * Route path helpers shared by the Hono and Express extractors and by the compiler's `route-match`
 * verifier (SPEC-IR §4.1): prefix composition, normalisation, `use()` pattern matching and the
 * declared-vs-extracted comparison.
 */

import type { HttpMethod, Router } from "@averri/ir";

/**
 * Normalise a route path for comparison and storage:
 * - Hono regex params `:id{[0-9]+}` -> `:id`
 * - optional params `:id?` -> `:id`
 * - Express 5 named wildcards `*splat` -> `*`, braced optional groups `{/x}` -> `/x` (a `${expr}` placeholder
 *   left by a dynamic path is kept as is)
 * - consecutive slashes collapsed, trailing slash removed (except `/`), leading slash ensured.
 */
export function normalizeRoutePath(path: string): string {
  let p = path.trim();
  p = p.replace(/:([A-Za-z_$][\w$]*)\{[^}]*\}/g, ":$1");
  p = p.replace(/:([A-Za-z_$][\w$]*)\?/g, ":$1");
  p = p.replace(/\*[A-Za-z_$][\w$]*/g, "*");
  p = p.replace(/(^|[^$])\{([^}]*)\}/g, "$1$2");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Concatenate static prefixes and a registered path (`"/api"`, `"/teams"`, `"/"` -> `/api/teams`), normalised. */
export function composePath(...segments: string[]): string {
  const joined = segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "/")
    .map((s) => (s.startsWith("/") ? s : `/${s}`))
    .join("");
  return normalizeRoutePath(joined.length === 0 ? "/" : joined);
}

/** `METHOD` upper-cased; null for methods Averri does not model (HEAD, OPTIONS, …). */
export function toHttpMethod(method: string): HttpMethod | null {
  const m = method.toUpperCase();
  return m === "GET" || m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE" ? m : null;
}

/** True when the path contains a wildcard segment (`*`, `/:rest*`, `/:rest{.+}` after normalisation becomes `:rest`). */
export function hasWildcard(path: string): boolean {
  return path.includes("*");
}

function segments(path: string): string[] {
  const n = normalizeRoutePath(path);
  return n === "/" ? [] : n.slice(1).split("/");
}

/**
 * Declared route vs extracted Exposure path (SPEC-IR §4.1): both normalised, param names must match,
 * wildcards never match.
 */
export function routePathsMatch(declared: string, extracted: string): boolean {
  const a = normalizeRoutePath(declared);
  const b = normalizeRoutePath(extracted);
  if (hasWildcard(a) || hasWildcard(b)) return false;
  return a === b;
}

/**
 * Does a `use()` pattern apply to a path, with the router's own semantics?
 * - Hono: `*` / `/*` match everything; `/teams/*` matches `/teams` and anything below it; a pattern
 *   without a trailing wildcard matches exactly (segment-wise, `:param` matches one segment).
 * - Express: a mount/use path is a prefix on a segment boundary (`/teams` matches `/teams/:id`);
 *   `:param` matches one segment; `*` (named or bare) matches the rest.
 */
export function usePatternMatches(router: Router, pattern: string | null, path: string): boolean {
  if (pattern === null) return true;
  const pat = segments(pattern);
  const target = segments(path);
  if (pat.length === 0) return true;
  if (router === "hono") return honoMatch(pat, target);
  return expressMatch(pat, target);
}

function honoMatch(pat: string[], target: string[]): boolean {
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === "*") return true;
    const t = target[i];
    if (t === undefined) return false;
    if (p.startsWith(":")) {
      if (p.endsWith("*")) return true;
      continue;
    }
    if (p !== t) return false;
  }
  return pat.length === target.length;
}

function expressMatch(pat: string[], target: string[]): boolean {
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === "*" || p.startsWith("*")) return true;
    const t = target[i];
    if (t === undefined) return false;
    if (p.startsWith(":")) continue;
    if (p !== t) return false;
  }
  return true;
}

/**
 * The bare callee of a middleware expression as written: `auth()` -> `auth`, `requireRole("admin")`
 * -> `requireRole`, `mw.auth()` -> `mw.auth`, `auth` -> `auth`. Used to compare with
 * `config.authMiddleware` / `config.publicMarker`.
 */
export function middlewareCallee(text: string): string {
  const t = text.trim();
  const m = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^()]*>)?\s*\(/.exec(t);
  if (m) return m[1]!.replace(/\s+/g, "");
  const id = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)$/.exec(t);
  return id ? id[1]!.replace(/\s+/g, "") : t;
}

/** True when the middleware's callee equals one of `names`, by full dotted name or by its last segment. */
export function middlewareMatches(middlewareText: string, names: readonly string[]): boolean {
  const callee = middlewareCallee(middlewareText);
  const last = callee.includes(".") ? callee.slice(callee.lastIndexOf(".") + 1) : callee;
  return names.some((n) => n === callee || n === last);
}
