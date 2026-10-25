/**
 * Observe mode (SPEC-DECLARATIONS §6, SPEC-CONTRACTS §8, D-6): a Vitest-only wrapper at the FETCH
 * boundary. Hono apps are called through `app.fetch(request)`; Express apps are served with
 * `http.createServer(app)` on an ephemeral port for the lifetime of the handle. Nothing is registered
 * on the app and `handler:` is never called. For each request matching a declared route:
 *
 * 1. validate: `{ ...body|query, ...params }` against the declared Zod schema (recorded; the request still goes to the app)
 * 2. authorize: Averri evaluates the policy AST against the fixture actor (`observed: false`), then records the
 *    app's own 401/403 vs 2xx as the decision (`observed: true`)
 * 3. before: subject row (`findFirst`), rows of entities with invariants (`findMany`), `requires` evaluated
 * 4. the real handler runs (emitter spy installed)
 * 5. after: subject reloaded, invariant entities re-read and diffed by `@id`, `ensures` evaluated with `result` = parsed
 *    JSON body (2xx only) and `emitted` = spy calls
 *
 * One `ActionTrace` per request with the Vitest file and title.
 */
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  averriMeta,
  isDeclaration,
  type ActionTrace,
  type Actor,
  type AnyActionDecl,
  type AnyQueryDecl,
  type AverriConfig,
  type AverriMetaOf,
  type ContractRecord,
  type FetchApp,
  type ListenerApp,
  type ObserveHandle,
  type ObserveOptions,
  type ObserveRequest,
  type ObserveResponse,
  type PhaseRecord,
  type PolicyDecl,
} from "@averri/core";
import { canonicalJson, stableHash, type EventId } from "@averri/ir";
import { mergeInput } from "./adapters.js";
import { evaluatePhase, evaluatePolicy, type ContractPhaseRecord } from "./contracts.js";
import { AverriRuntimeError, errorMessage } from "./errors.js";
import { elapsed } from "./guards.js";
import { compileRoute, findRoute, type CompiledRoute } from "./matcher.js";
import { entityInvariants, includeTree, ownedListPaths } from "./pipeline.js";
import { compileWhere, modelOf } from "./predicates.js";
import { actorSummary, currentVitestTest, defaultTraceRecorder, newTraceId, redactHeaders, type TraceRecorder } from "./trace.js";
import type { PrismaLike, Row } from "./types.js";
import { deepCopy, isRecord, toJsonValue } from "./values.js";

export interface ObserveWrapperOptions extends ObserveOptions {
  /** The project's Prisma client for subject/invariant snapshots and tier-2 predicates. Without it those evaluate fail-closed. */
  prisma?: PrismaLike | null;
  /** Trace sink. `undefined` → `.averri/traces` file recorder; `null` → none. */
  recorder?: TraceRecorder | null;
  /** Override the Vitest test info (default `expect.getState()`). */
  test?: ActionTrace["test"];
  now?: () => Date;
}

interface ObservedRoute {
  decl: AnyActionDecl | AnyQueryDecl;
  meta: AverriMetaOf<"action"> | AverriMetaOf<"query">;
  route: CompiledRoute;
}

interface InvariantEntity {
  clientName: string;
  records: readonly ContractRecord[];
}

/** The fetch-boundary transport observe() uses; exported for the test harness's raw requests. */
export interface Transport {
  send(req: { method: string; url: string; headers: Record<string, string>; body: string | undefined }): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

interface SpyHandle {
  emitted: EventId[];
  calls: Array<{ name: string; payload: unknown }>;
  restore(): void;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json") || /^[\s]*[[{"]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Hono-style apps are called through `app.fetch`; Express-style listeners are served on an ephemeral port. */
export async function createTransport(app: FetchApp | ListenerApp): Promise<Transport> {
  return typeof app === "function" ? listenerTransport(app) : fetchTransport(app);
}

function fetchTransport(app: FetchApp): Transport {
  return {
    async send(req) {
      const response = await app.fetch(new Request(req.url, { method: req.method, headers: req.headers, body: req.body }));
      return { status: response.status, body: await parseBody(response) };
    },
    close: async () => undefined,
  };
}

async function listenerTransport(app: ListenerApp): Promise<Transport & { port: number }> {
  const server: Server = createServer(app as unknown as RequestListener);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    async send(req) {
      const url = new URL(req.url);
      url.protocol = "http:";
      url.host = `127.0.0.1:${port}`;
      const response = await fetch(url, { method: req.method, headers: req.headers, body: req.body });
      return { status: response.status, body: await parseBody(response) };
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}

// ---------------------------------------------------------------------------
// Emitter spy
// ---------------------------------------------------------------------------

/** Wraps `target[method]` for the duration of one request and records event names/payloads. */
export function installEmitterSpy(spy: { target: object; method: string }, eventNamePrefix: string): SpyHandle {
  const target = spy.target as Record<string, unknown>;
  const original = target[spy.method];
  const own = Object.prototype.hasOwnProperty.call(target, spy.method);
  const calls: SpyHandle["calls"] = [];
  const emitted: EventId[] = [];
  const note = (arg: unknown, payloadArg: unknown): void => {
    let name: string | null = null;
    let payload: unknown = payloadArg;
    if (typeof arg === "string") name = arg;
    else if (isRecord(arg) && typeof arg.name === "string") {
      name = arg.name;
      payload = arg.data ?? arg.payload ?? payloadArg;
    }
    if (name === null) return;
    const bare = name.startsWith(eventNamePrefix) ? name.slice(eventNamePrefix.length) : name;
    calls.push({ name, payload });
    emitted.push(`Event:${bare}`);
  };
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    const first = args[0];
    if (Array.isArray(first)) for (const item of first) note(item, undefined);
    else note(first, args[1]);
    return typeof original === "function" ? (original as (...a: unknown[]) => unknown).apply(this === wrapper ? target : (this ?? target), args) : undefined;
  };
  Object.defineProperty(target, spy.method, { value: wrapper, configurable: true, writable: true, enumerable: own });
  return {
    emitted,
    calls,
    restore() {
      if (own) Object.defineProperty(target, spy.method, { value: original, configurable: true, writable: true, enumerable: true });
      else delete target[spy.method];
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowKey(row: Row): string {
  const id = row.id;
  if (typeof id === "string" || typeof id === "number" || typeof id === "bigint") return `id:${String(id)}`;
  return `row:${canonicalJson(toJsonValue(row))}`;
}

async function snapshot(prisma: PrismaLike | null | undefined, entity: InvariantEntity): Promise<Map<string, string> | null> {
  if (prisma === null || prisma === undefined) return null;
  try {
    const rows = await modelOf(prisma, entity.clientName).findMany({});
    const out = new Map<string, string>();
    for (const row of rows) out.set(rowKey(row), canonicalJson(toJsonValue(row)));
    return out;
  } catch {
    return null;
  }
}

async function changedRows(prisma: PrismaLike, entity: InvariantEntity, before: Map<string, string> | null): Promise<Row[]> {
  try {
    const rows = await modelOf(prisma, entity.clientName).findMany({});
    return rows.filter((row) => before === null || before.get(rowKey(row)) !== canonicalJson(toJsonValue(row)));
  } catch {
    return [];
  }
}

async function loadSubjectRow(meta: AverriMetaOf<"action">, prisma: PrismaLike | null | undefined, env: { input: unknown; actor: Actor | null }, include: Record<string, unknown> | undefined): Promise<Row | null> {
  if (meta.subject === null || prisma === null || prisma === undefined) return null;
  const compiled = compileWhere(meta.subject.where, env);
  if (compiled.undefinedRefs.length > 0) return null;
  try {
    const model = modelOf(prisma, meta.subject.clientName);
    const args: { where: unknown; include?: unknown } = { where: compiled.where };
    if (include !== undefined) args.include = include;
    if (typeof model.findFirst === "function") return (await model.findFirst(args)) ?? null;
    return (await model.findMany({ ...args, take: 1 }))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The app's decision read off the status. A 404 counts as a denial when the declared policy denies:
 * apps commonly answer "not found" for resources outside the actor's reach (D-40).
 */
function observedDecision(status: number, isPublic: boolean, expectedDenied = false): Extract<PhaseRecord, { phase: "authorize" }>["decision"] {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "deny";
  if (status === 404 && expectedDenied) return "deny";
  return isPublic ? "public" : "allow";
}

function denied(decision: Extract<PhaseRecord, { phase: "authorize" }>["decision"]): boolean {
  return decision === "deny" || decision === "unauthenticated";
}

function buildInput(method: string, path: string, body: unknown, params: Record<string, string>): { input: Record<string, unknown>; body: unknown } {
  const url = new URL(path, "http://averri.local");
  const query = Object.fromEntries(url.searchParams);
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }
  return { input: mergeInput(method, parsed, query, params), body: parsed };
}

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

/** Wraps an app for the duration of a test file. Only observe-mode actions/queries are matched (declared-mode ones record their own traces). */
export async function observe(app: FetchApp | ListenerApp, options: ObserveWrapperOptions): Promise<ObserveHandle> {
  const config: AverriConfig = options.config;
  const routes: ObservedRoute[] = [];
  const invariantEntities: InvariantEntity[] = [];
  for (const decl of options.declarations) {
    if (!isDeclaration(decl)) continue;
    if (decl.kind === "action" || decl.kind === "query") {
      const meta = averriMeta(decl);
      if (meta.mode !== "observe" || meta.route === null) continue;
      routes.push({ decl, meta, route: compileRoute(meta.route) });
    } else if (decl.kind === "entity") {
      const meta = averriMeta(decl);
      if (meta.contracts.length > 0) invariantEntities.push({ clientName: meta.clientName, records: meta.contracts });
    }
  }
  const transport: Transport = await createTransport(app);
  const prisma = options.prisma ?? null;
  const now = options.now ?? (() => new Date());
  const recorder = options.recorder === undefined ? defaultTraceRecorder() : options.recorder;

  async function request(actorFixture: string, req: ObserveRequest): Promise<ObserveResponse> {
    const fixture = config.actors[actorFixture];
    if (fixture === undefined) {
      throw new AverriRuntimeError("unknown-fixture", `unknown actor fixture "${actorFixture}" (configured: ${Object.keys(config.actors).join(", ")})`);
    }
    const actor = (fixture.actor ?? null) as Actor | null;
    const headers: Record<string, string> = { ...(fixture.headers ?? {}), ...(req.headers ?? {}) };
    const bodyText = req.body === undefined ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (bodyText !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    const url = new URL(req.path, "http://averri.local").toString();
    const send = (): Promise<{ status: number; body: unknown }> => transport.send({ method: req.method, url, headers, body: bodyText });

    const pathname = new URL(url).pathname;
    const matched = findRoute(routes, req.method, pathname);
    if (matched === null) {
      const response = await send();
      return { status: response.status, body: response.body, trace: null };
    }
    const { meta, decl } = matched.entry;
    const startedAt = now();
    const t0 = performance.now();
    const phases: PhaseRecord[] = [];
    const { input: rawInput, body: parsedBody } = buildInput(req.method, req.path, req.body, matched.params);

    // 1. validate
    const schema = (decl.options as { input: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues?: unknown[] } } } }).input;
    const parsed = schema.safeParse(rawInput);
    let input: unknown = rawInput;
    if (parsed.success) {
      phases.push({ phase: "validate", ok: true });
      input = parsed.data;
    } else {
      phases.push({ phase: "validate", ok: false, issues: (toJsonValue(parsed.error?.issues ?? []) as unknown[]) ?? [] });
    }

    // 2. authorize (Averri's evaluation)
    let expected: Extract<PhaseRecord, { phase: "authorize" }>["decision"];
    if (meta.public) expected = "public";
    else if (actor === null) expected = "unauthenticated";
    else {
      const policyDecl = (decl.options as { policy?: PolicyDecl }).policy;
      if (policyDecl !== undefined && isDeclaration(policyDecl)) {
        const verdict = await evaluatePolicy(policyDecl, { input, actor }, { prisma, guardPrisma: prisma });
        expected = verdict.allow ? "allow" : "deny";
      } else {
        expected = "deny";
      }
    }
    phases.push({ phase: "authorize", ok: !denied(expected), policy: meta.policy, decision: expected, observed: false });

    // 3. before
    const isAction = meta.kind === "action";
    const requires = isAction ? meta.contracts.filter((c) => c.phase === "requires") : [];
    const ensures = isAction ? meta.contracts.filter((c) => c.phase === "ensures") : [];
    const include = isAction ? includeTree(ownedListPaths([...requires, ...ensures])) : undefined;
    const subjectInvariants = isAction && meta.subject !== null ? entityInvariants((decl.options as { subject?: { entity: never } }).subject?.entity, options.declarations) : [];
    const self = isAction ? await loadSubjectRow(meta, prisma, { input, actor }, include) : null;
    const old = self === null ? null : deepCopy(self);
    const before = new Map<InvariantEntity, Map<string, string> | null>();
    for (const entity of invariantEntities) before.set(entity, await snapshot(prisma, entity));
    // Contracts are evaluated only over input the declared schema accepts; invariants (DB state) are diffed regardless.
    const contractsApply = parsed.success;
    if (contractsApply && requires.length > 0) {
      const result = await evaluatePhase("requires", requires, { input, actor, self, old: self }, { prisma, guardPrisma: prisma });
      phases.push(...result.records);
    }

    // 4. the real handler
    const spy = config.emitter !== null ? installEmitterSpy(config.emitter.spy, config.emitter.eventNamePrefix) : null;
    const runStarted = performance.now();
    let response: { status: number; body: unknown };
    try {
      response = await send();
    } catch (error) {
      spy?.restore();
      phases.push({ phase: "run", ok: false, durationMs: elapsed(runStarted), dbCalls: 0, error: errorMessage(error) });
      throw error;
    }
    spy?.restore();
    const appDecision = observedDecision(response.status, meta.public, denied(expected));
    phases.push({ phase: "authorize", ok: denied(expected) === denied(appDecision), policy: meta.policy, decision: appDecision, observed: true });
    const runRecord: Extract<PhaseRecord, { phase: "run" }> = { phase: "run", ok: response.status < 500, durationMs: elapsed(runStarted), dbCalls: 0 };
    if (response.status >= 500) runRecord.error = `handler responded ${response.status}`;
    phases.push(runRecord);
    // Emissions observed through the spy during the run (D-40: recorded only when something was emitted).
    if (spy !== null && spy.calls.length > 0) {
      phases.push({
        phase: "emit",
        ok: true,
        events: spy.calls.map((call, i) => ({ event: spy.emitted[i] as EventId, payloadHash: stableHash(toJsonValue(call.payload) ?? null) })),
      });
    }

    // 5. after
    const ok2xx = response.status >= 200 && response.status < 300;
    if (isAction) {
      const after = await loadSubjectRow(meta, prisma, { input, actor }, include);
      const env = { input, actor, self: after, old, result: ok2xx ? response.body : undefined, emitted: spy?.emitted ?? [] };
      if (contractsApply && ensures.length > 0 && ok2xx) {
        const result = await evaluatePhase("ensures", ensures, env, { prisma, guardPrisma: prisma });
        phases.push(...result.records);
      }
      if (after !== null && subjectInvariants.length > 0) {
        const result = await evaluatePhase("ensures", subjectInvariants, { self: after }, { prisma, guardPrisma: prisma });
        phases.push(...result.records);
      }
    }
    if (prisma !== null) {
      for (const entity of invariantEntities) {
        const changed = await changedRows(prisma, entity, before.get(entity) ?? null);
        const failed = new Set<string>();
        for (const row of changed) {
          const result = await evaluatePhase("ensures", entity.records, { self: row }, { prisma, guardPrisma: prisma });
          for (const record of result.records) {
            if (record.ok || failed.has(record.contract)) continue;
            failed.add(record.contract);
            phases.push(record);
          }
        }
      }
    }

    // trace
    const firstFailure = phases.find((p) => !p.ok && !(p.phase === "validate" && !ok2xx) && !(p.phase === "authorize" && !p.observed));
    const outcome: ActionTrace["outcome"] =
      firstFailure === undefined
        ? { ok: true }
        : {
            ok: false,
            phase: firstFailure.phase,
            ...("contract" in firstFailure ? { contract: (firstFailure as ContractPhaseRecord).contract } : {}),
            message: describeObservedFailure(firstFailure, response.status),
            committed: firstFailure.phase === "ensures" || firstFailure.phase === "run",
          };
    const trace: ActionTrace = {
      traceId: newTraceId(),
      action: meta.id,
      mode: "observe",
      startedAt: startedAt.toISOString(),
      durationMs: elapsed(t0),
      actor: actorSummary(actor),
      phases,
      outcome,
      request: { method: req.method, path: req.path, body: parsedBody ?? null, headers: redactHeaders(headers) },
    };
    const test = options.test ?? (await currentVitestTest());
    if (test !== undefined) trace.test = test;
    if (recorder !== null) {
      try {
        recorder.record(trace);
      } catch {
        // never affects the response
      }
    }
    return { status: response.status, body: response.body, trace };
  }

  return {
    request,
    close: () => transport.close(),
  };
}

function describeObservedFailure(record: PhaseRecord, status: number): string {
  switch (record.phase) {
    case "validate":
      return `declared input schema rejected the request but the app responded ${status}`;
    case "authorize":
      return `app responded ${status} (${record.decision}) but the declared policy expected the opposite`;
    case "requires":
    case "ensures":
      return `${record.contract} evaluated to false`;
    case "run":
      return record.error ?? `handler responded ${status}`;
    case "emit":
      return record.error ?? "emit failed";
  }
}
