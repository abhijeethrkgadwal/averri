/**
 * Declared-mode adapters (SPEC-DECLARATIONS §6, D-20): `toHono(decl, options)` and `toExpress(decl, options)`.
 * Input is `{ ...(GET ? query : body), ...params }` (path params win), status 200 by default, bodies
 * serialised by {@link serializeResult}. Frameworks are seen structurally; nothing is imported from them.
 */
import type { ActionTrace, Actor, ActorOf, AdapterOptions, AnyActionDecl, AnyQueryDecl, HttpMethod } from "@averri/core";
import { invoke, type RuntimeOptions } from "./pipeline.js";
import { redactHeaders } from "./trace.js";
import { isRecord } from "./values.js";

/** What `toHono` needs from a Hono `Context`. */
export interface HonoLikeContext {
  req: {
    method: string;
    path: string;
    raw: Request;
    param(): Record<string, string> | undefined;
    query(): Record<string, string>;
    json(): Promise<unknown>;
    header(): Record<string, string>;
  };
  json?(object: unknown, status?: number): Response;
}

/** What `toExpress` needs from an Express `Request`/`Response`. */
export interface ExpressLikeRequest {
  method: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  params?: Record<string, string>;
  query?: unknown;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}
export interface ExpressLikeResponse {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Core's `AdapterOptions` plus the runtime binding. `actor` may always return `null` (anonymous → 401),
 * even for policy-protected declarations whose `ActorOf<D>` is non-null: the extractor runs at the HTTP
 * boundary, before authentication is known.
 */
export type WithNullableActor<Req, A extends Actor | null> = Omit<AdapterOptions<Req, A>, "actor"> & {
  actor(req: Req): A | null | Promise<A | null>;
};
export type HonoAdapterOptions<C, A extends Actor | null> = WithNullableActor<C, A> & RuntimeOptions;
export type ExpressAdapterOptions<Req, A extends Actor | null> = WithNullableActor<Req, A> & RuntimeOptions;

/** `{ ...(GET/HEAD ? query : body), ...params }` — path params win on key clash (D-20, D-41h). */
export function mergeInput(method: string, body: unknown, query: unknown, params: unknown): Record<string, unknown> {
  const m = method.toUpperCase();
  const base = m === "GET" || m === "HEAD" ? query : body;
  return { ...(isRecord(base) ? base : {}), ...(isRecord(params) ? params : {}) };
}

function asMethod(method: string): HttpMethod {
  return method.toUpperCase() as HttpMethod;
}

async function honoBody(c: HonoLikeContext): Promise<unknown> {
  const m = c.req.method.toUpperCase();
  if (m === "GET" || m === "HEAD") return undefined;
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Hono handler. The A2101 fix recognises `toHono(<Decl>, ...)` as the Exposure's handler. */
export function toHono<D extends AnyActionDecl | AnyQueryDecl, C>(decl: D, options: HonoAdapterOptions<C, ActorOf<D>>): (c: C) => Promise<Response> {
  return async (c: C): Promise<Response> => {
    const ctx = c as unknown as HonoLikeContext;
    const method = ctx.req.method;
    const actor = await options.actor(c);
    const body = options.input === undefined ? await honoBody(ctx) : undefined;
    const input = options.input !== undefined ? await options.input(c) : mergeInput(method, body, ctx.req.query(), ctx.req.param() ?? {});
    const request: ActionTrace["request"] = { method: asMethod(method), path: ctx.req.path, body: body ?? null, headers: redactHeaders(ctx.req.header()) };
    const result = await invoke(decl, { ...options, input, actor, request });
    if (typeof ctx.json === "function") return ctx.json(result.body, result.status);
    return Response.json(result.body, { status: result.status });
  };
}

/** Express handler (`express.json()` must run before it for JSON bodies). Errors go to `next(err)`. */
export function toExpress<D extends AnyActionDecl | AnyQueryDecl, Req, Res>(
  decl: D,
  options: ExpressAdapterOptions<Req, ActorOf<D>>,
): (req: Req, res: Res, next: (err?: unknown) => void) => Promise<void> {
  return async (req: Req, res: Res, next: (err?: unknown) => void): Promise<void> => {
    try {
      const r = req as unknown as ExpressLikeRequest;
      const actor = await options.actor(req);
      const input = options.input !== undefined ? await options.input(req) : mergeInput(r.method, r.body, r.query, r.params);
      const path = r.path ?? (r.originalUrl ?? r.url ?? "/").split("?")[0] ?? "/";
      const request: ActionTrace["request"] = { method: asMethod(r.method), path, body: r.body ?? null, headers: redactHeaders(r.headers) };
      const result = await invoke(decl, { ...options, input, actor, request });
      (res as unknown as ExpressLikeResponse).status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  };
}
