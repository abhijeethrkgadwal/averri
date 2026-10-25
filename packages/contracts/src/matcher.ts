/**
 * Averri's own route matcher for observe mode, using the SPEC-IR §4.1 normalisation: Hono regex
 * params `:id{[0-9]+}` → `:id`, optional params `:id?` → `:id`, trailing slash removed (except `/`),
 * method upper-cased, consecutive slashes collapsed. Wildcards (`*`, `:rest*`) never match.
 */
import type { HttpMethod, RouteSpec } from "@averri/ir";

export type RouteSegment = { kind: "static"; value: string } | { kind: "param"; name: string };

export interface CompiledRoute {
  method: HttpMethod;
  /** Normalised template. */
  path: string;
  segments: RouteSegment[];
  wildcard: boolean;
}

export function normaliseRoutePath(path: string): string {
  let p = path.split("?")[0] ?? "";
  p = p.replace(/:([A-Za-z_$][\w$]*)\{[^}]*\}/g, ":$1");
  p = p.replace(/:([A-Za-z_$][\w$]*)\?/g, ":$1");
  p = p.replace(/\/{2,}/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

export function compileRoute(route: RouteSpec): CompiledRoute {
  const path = normaliseRoutePath(route.path);
  const segments: RouteSegment[] = [];
  let wildcard = false;
  for (const raw of path.split("/").slice(1)) {
    if (raw === "" && path === "/") continue;
    if (raw.includes("*")) {
      wildcard = true;
      continue;
    }
    if (raw.startsWith(":")) segments.push({ kind: "param", name: raw.slice(1) });
    else segments.push({ kind: "static", value: raw });
  }
  return { method: route.method.toUpperCase() as HttpMethod, path, segments, wildcard };
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Params of the request when it matches the compiled route, else null. */
export function matchRoute(route: CompiledRoute, method: string, pathname: string): Record<string, string> | null {
  if (route.wildcard) return null;
  if (method.toUpperCase() !== route.method) return null;
  const path = normaliseRoutePath(pathname);
  const parts = path === "/" ? [] : path.split("/").slice(1);
  if (parts.length !== route.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const segment = route.segments[i] as RouteSegment;
    const part = parts[i] as string;
    if (segment.kind === "static") {
      if (segment.value !== part) return null;
    } else {
      if (part === "") return null;
      params[segment.name] = decode(part);
    }
  }
  return params;
}

/** First matching route in declaration order. */
export function findRoute<T extends { route: CompiledRoute }>(routes: readonly T[], method: string, pathname: string): { entry: T; params: Record<string, string> } | null {
  for (const entry of routes) {
    const params = matchRoute(entry.route, method, pathname);
    if (params !== null) return { entry, params };
  }
  return null;
}
