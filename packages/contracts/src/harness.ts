/**
 * The test harness generated tests import (`createTestHarness`). The surface is fixed by
 * `packages/testgen/src/harness-api.ts`; this is its implementation over the runtime:
 *
 * - declarations are resolved by `averriMeta(decl).id` across every export of `modules` (single
 *   declarations and arrays of declarations);
 * - observe-mode Actions/Queries go through `observe(app)` at the fetch boundary, declared-mode ones
 *   through `invoke()`; `emitted()` is captured by an outer spy on `config.emitter.spy`;
 * - the Prisma client is `init.prisma`, else the entry module's `prisma`/`db` export, else
 *   `new PrismaClient()` from the project's `@prisma/client` (resolved from `process.cwd()`).
 */
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  averriMeta,
  isDeclaration,
  type Actor,
  type AnyActionDecl,
  type AnyQueryDecl,
  type AverriConfig,
  type Declaration,
  type EntityDecl,
  type FetchApp,
  type HttpMethod,
  type ListenerApp,
  type ObserveHandle,
  type PolicyDecl,
  type WorkflowDecl,
} from "@averri/core";
import type { EventId } from "@averri/ir";
import { evaluateInvariants, evaluatePolicy } from "./contracts.js";
import { AverriRuntimeError } from "./errors.js";
import { normaliseRoutePath } from "./matcher.js";
import { createTransport, installEmitterSpy, observe, type Transport } from "./observe.js";
import { invoke as invokeDeclared } from "./pipeline.js";
import type { TraceRecorder } from "./trace.js";
import type { PrismaLike, Row } from "./types.js";
import { isRecord, toJsonValue } from "./values.js";
import { conformInput, type SampleOptions } from "./zod-sample.js";

export interface HarnessInit {
  /** The default export of `averri.config.ts`. */
  config: object;
  /** Module namespace of the configured entry point; the harness uses its `default` or `app` export. */
  app?: Record<string, unknown> | null;
  /** Module namespaces whose exports include every declaration the test file references. */
  modules: ReadonlyArray<Record<string, unknown>>;
  /** Explicit Prisma client. Default: entry `prisma`/`db` export, else `new PrismaClient()`. */
  prisma?: object;
  /** Trace sink; default the `.averri/traces` file recorder. `null` disables traces. */
  recorder?: TraceRecorder | null;
}

export interface HarnessPhase {
  phase: string;
  ok: boolean;
  contract?: string;
  policy?: string | null;
  decision?: string;
  events?: ReadonlyArray<{ event: string; payloadHash: string }>;
}

export interface HarnessTrace {
  phases: ReadonlyArray<HarnessPhase>;
  outcome: { ok: boolean; phase?: string; contract?: string; message?: string };
}

export interface HarnessInvokeResult {
  status: number;
  body: unknown;
  trace: HarnessTrace | null;
}

export interface HarnessRawRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export type HarnessPolicyDecision = "allow" | "deny" | "unauthenticated" | "public" | "opaque";

export interface HarnessModel {
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findFirst(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> }): Promise<Array<Record<string, unknown>>>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface AverriTestHarness {
  invoke(owner: string, fixture: string, input: unknown, options?: { headers?: Record<string, string> }): Promise<HarnessInvokeResult>;
  rawRequest(req: HarnessRawRequest): Promise<{ status: number; body: unknown }>;
  policyDecision(owner: string, fixture: string, input: unknown): Promise<HarnessPolicyDecision>;
  parseInput(owner: string, raw: unknown): { ok: boolean; value?: unknown; issues?: unknown };
  /** `raw` conformed to the owner's Zod input schema (see `conformInput` in zod-sample.ts); null when impossible. */
  conformInput(owner: string, raw: unknown): Record<string, unknown> | null;
  actor(fixture: string): Record<string, unknown> | null;
  prisma: Record<string, HarnessModel>;
  snapshot(models: ReadonlyArray<string>): Promise<Record<string, unknown[]>>;
  emitted(): ReadonlyArray<{ event: string; payload: unknown }>;
  consumerRegistered(event: string, workflow: string): Promise<boolean>;
  invariantViolations(entity: string): Promise<ReadonlyArray<{ contract: string; row: unknown }>>;
  close(): Promise<void>;
}

type Endpoint = AnyActionDecl | AnyQueryDecl;
type SafeParser = { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues?: unknown } } };

/** Every declaration among a module's exports (direct values and arrays), keyed by IR id. */
export function collectDeclarations(modules: ReadonlyArray<Record<string, unknown>>): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  const add = (value: unknown): void => {
    if (isDeclaration(value)) {
      const id = averriMeta(value).id as string;
      if (!out.has(id)) out.set(id, value);
    }
  };
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (Array.isArray(value)) value.forEach(add);
      else add(value);
    }
  }
  return out;
}

/** `default` or `app` export of the entry module; accepts a Hono-style app, an Express listener, or `{ app }`. */
export function resolveApp(entry: Record<string, unknown> | null | undefined): FetchApp | ListenerApp | null {
  if (entry === null || entry === undefined) return null;
  for (const candidate of [entry.default, entry.app]) {
    if (typeof candidate === "function") return candidate as ListenerApp;
    if (isRecord(candidate)) {
      if (typeof candidate.fetch === "function") return candidate as unknown as FetchApp;
      const inner = candidate.app;
      if (isRecord(inner) && typeof inner.fetch === "function") return inner as unknown as FetchApp;
      if (typeof inner === "function") return inner as ListenerApp;
    }
  }
  return null;
}

function looksLikePrisma(value: unknown): value is PrismaLike {
  return isRecord(value) && (typeof value.$transaction === "function" || typeof value.$connect === "function");
}

async function defaultPrismaClient(): Promise<{ client: PrismaLike; owned: boolean }> {
  const require = createRequire(join(process.cwd(), "package.json"));
  let resolved: string;
  try {
    resolved = require.resolve("@prisma/client");
  } catch {
    throw new AverriRuntimeError("no-prisma", "createTestHarness: no Prisma client given and @prisma/client is not resolvable from the working directory");
  }
  const mod = (await import(pathToFileURL(resolved).href)) as { PrismaClient?: new () => PrismaLike; default?: { PrismaClient?: new () => PrismaLike } };
  const Ctor = mod.PrismaClient ?? mod.default?.PrismaClient;
  if (Ctor === undefined) throw new AverriRuntimeError("no-prisma", "createTestHarness: @prisma/client exports no PrismaClient (run `prisma generate`)");
  return { client: new Ctor(), owned: true };
}

/** fast-check's `stringMatching` when the project has fast-check (generated tests import it); else null. */
async function regexSampler(): Promise<SampleOptions["stringMatching"]> {
  try {
    const fc = (await import("fast-check")) as unknown as {
      sample<T>(arb: unknown, n: number): T[];
      stringMatching(re: RegExp): unknown;
    };
    return (re: RegExp) => {
      try {
        return fc.sample<string>(fc.stringMatching(re), 1)[0] ?? null;
      } catch {
        return null;
      }
    };
  } catch {
    return null;
  }
}

/**
 * Substitute `:param` segments from `input` and send the rest as the query (GET/HEAD) or a JSON body
 * (everything else, DELETE included). This is the exact inverse of `mergeInput`, which observe mode
 * uses to rebuild the input from the request (D-20, D-41h): `GET/HEAD → query`, otherwise body.
 */
export function requestFor(method: string, routePath: string, input: unknown): { path: string; body?: unknown } {
  const rest: Record<string, unknown> = isRecord(input) ? { ...input } : {};
  const path = routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)\??/g, (_m, name: string) => {
    if (!(name in rest) || rest[name] === undefined || rest[name] === null) {
      throw new AverriRuntimeError("bad-declaration", `route ${method} ${routePath}: input has no value for path parameter "${name}"`);
    }
    const value = String(rest[name]);
    delete rest[name];
    return encodeURIComponent(value);
  });
  if (method === "GET" || method === "HEAD") {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((item) => query.append(k, String(item)));
      else query.append(k, v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const qs = query.toString();
    return { path: qs === "" ? path : `${path}?${qs}` };
  }
  // A DELETE without non-path input stays bodyless, like a browser or curl would send it.
  if (method === "DELETE" && Object.keys(rest).length === 0) return { path };
  return { path, body: rest };
}

/**
 * Signature headers for a request to a declared integration webhook route, when the scheme is one
 * Averri can produce (`stripe`, `hmac-sha256`) and the secret env var is set; else null.
 */
export function webhookSigner(declarations: Iterable<Declaration>, method: string, path: string, env: NodeJS.ProcessEnv = process.env): ((body: string) => Record<string, string>) | null {
  for (const decl of declarations) {
    if (decl.kind !== "integration") continue;
    const webhook = (decl.options as { webhook?: { verify: string; scheme: string; secretEnv?: string; route?: { method: string; path: string } } }).webhook;
    if (!webhook?.route || webhook.route.method !== method || normaliseRoutePath(webhook.route.path) !== normaliseRoutePath(path)) continue;
    const secret = webhook.secretEnv ? env[webhook.secretEnv] : undefined;
    if (secret === undefined || (webhook.scheme !== "stripe" && webhook.scheme !== "hmac-sha256")) return null;
    const header = webhook.verify;
    return webhook.scheme === "stripe"
      ? (body) => {
          const t = Math.floor(Date.now() / 1000);
          return { [header]: `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}` };
        }
      : (body) => ({ [header]: createHmac("sha256", secret).update(body).digest("hex") });
  }
  return null;
}

/** Event name → names the runner object declares (custom `{ event }`, Inngest `opts.triggers[].event`, `{ events: [] }`). */
function runnerEvents(runner: unknown): string[] | null {
  if (!isRecord(runner)) return null;
  const out: string[] = [];
  if (typeof runner.event === "string") out.push(runner.event);
  if (Array.isArray(runner.events)) for (const e of runner.events) if (typeof e === "string") out.push(e);
  const opts = isRecord(runner.opts) ? runner.opts : null;
  const triggers = Array.isArray(runner.triggers) ? runner.triggers : opts && Array.isArray(opts.triggers) ? opts.triggers : null;
  if (triggers) for (const t of triggers) if (isRecord(t) && typeof t.event === "string") out.push(t.event);
  return out.length > 0 ? out : null;
}

/** Listener count for `name` on the emitter, when the emitter exposes one (`subscriberCount`, `listenerCount`). */
function listenerCount(target: unknown, name: string): number | null {
  if (target === null || typeof target !== "object") return null;
  const t = target as Record<string, unknown>;
  for (const method of ["subscriberCount", "listenerCount"]) {
    const fn = t[method];
    if (typeof fn === "function") {
      const n = (fn as (n: string) => unknown).call(target, name);
      if (typeof n === "number") return n;
    }
  }
  return null;
}

export async function createTestHarness(init: HarnessInit): Promise<AverriTestHarness> {
  const config = init.config as AverriConfig;
  if (!isRecord(config) || !isRecord((config as { actors?: unknown }).actors)) {
    throw new AverriRuntimeError("bad-config", "createTestHarness: `config` must be the default export of averri.config.ts (defineConfig)");
  }
  const byId = collectDeclarations(init.modules);
  const declarations = [...byId.values()];
  const app = resolveApp(init.app ?? null);

  let prisma: PrismaLike | null = null;
  let ownsPrisma = false;
  if (init.prisma !== undefined) prisma = init.prisma as PrismaLike;
  else if (init.app && looksLikePrisma(init.app.prisma)) prisma = init.app.prisma;
  else if (init.app && looksLikePrisma(init.app.db)) prisma = init.app.db;
  else {
    const made = await defaultPrismaClient();
    prisma = made.client;
    ownsPrisma = made.owned;
  }

  const recorder = init.recorder;
  let observed: ObserveHandle | null = null;
  let transport: Transport | null = null;
  const needsApp = declarations.some((d) => (d.kind === "action" || d.kind === "query") && averriMeta(d).mode === "observe") || declarations.some((d) => d.kind === "integration");
  if (app !== null) {
    observed = await observe(app, { declarations, config, prisma, ...(recorder !== undefined ? { recorder } : {}) });
    transport = await createTransport(app);
  } else if (needsApp) {
    throw new AverriRuntimeError("bad-config", "createTestHarness: observe-mode declarations need the entry module to export the app as `default` or `app`");
  }

  let lastEmitted: Array<{ event: string; payload: unknown }> = [];
  const sampling: SampleOptions = { stringMatching: await regexSampler() };

  const endpoint = (owner: string): Endpoint => {
    const decl = byId.get(owner);
    if (decl === undefined) throw new AverriRuntimeError("bad-declaration", `createTestHarness: ${owner} is not exported by any module passed in \`modules\``);
    if (decl.kind !== "action" && decl.kind !== "query") throw new AverriRuntimeError("bad-declaration", `${owner} is not an action or query`);
    return decl as Endpoint;
  };
  const fixtureOf = (name: string) => {
    const fixture = config.actors[name];
    if (fixture === undefined) throw new AverriRuntimeError("unknown-fixture", `unknown actor fixture "${name}" (configured: ${Object.keys(config.actors).join(", ")})`);
    return fixture;
  };
  const parse = (decl: Endpoint, raw: unknown) => {
    const schema = (decl.options as { input?: SafeParser }).input;
    if (schema === undefined || typeof schema.safeParse !== "function") return { ok: true, value: raw };
    const r = schema.safeParse(raw);
    return r.success ? { ok: true, value: r.data } : { ok: false, issues: toJsonValue(r.error?.issues ?? []) };
  };

  async function withSpy<T>(fn: () => Promise<T>): Promise<T> {
    lastEmitted = [];
    const emitter = config.emitter ?? null;
    if (emitter === null) return fn();
    const spy = installEmitterSpy(emitter.spy, emitter.eventNamePrefix);
    try {
      return await fn();
    } finally {
      spy.restore();
      lastEmitted = spy.calls.map((call, i) => ({ event: spy.emitted[i] as string, payload: call.payload }));
    }
  }

  const harness: AverriTestHarness = {
    async invoke(owner, fixtureName, input, options) {
      const decl = endpoint(owner);
      const meta = averriMeta(decl);
      const fixture = fixtureOf(fixtureName);
      if (meta.mode === "declared") {
        const result = await withSpy(() =>
          invokeDeclared(decl, {
            input,
            actor: (fixture.actor ?? null) as Actor | null,
            prisma: prisma as PrismaLike,
            config,
            declarations,
            ...(recorder !== undefined ? { recorder } : {}),
          }),
        );
        if (lastEmitted.length === 0) {
          const emit = result.trace.phases.find((p) => p.phase === "emit");
          if (emit && emit.phase === "emit") lastEmitted = emit.events.map((e) => ({ event: e.event, payload: undefined }));
        }
        return { status: result.status, body: result.body, trace: result.trace as unknown as HarnessTrace };
      }
      if (observed === null) throw new AverriRuntimeError("bad-config", `${owner} is observe-mode but no app was given to createTestHarness`);
      if (meta.route === null) throw new AverriRuntimeError("bad-declaration", `${owner} has no route to request`);
      const handle = observed;
      const req = requestFor(meta.route.method, meta.route.path, input);
      // Requests to a declared webhook route are signed over the exact bytes sent (the app verifies them).
      const signer = webhookSigner(declarations, meta.route.method, meta.route.path);
      const body = signer !== null && req.body !== undefined ? JSON.stringify(req.body) : req.body;
      const headers = { ...(signer !== null && typeof body === "string" ? signer(body) : {}), ...(options?.headers ?? {}) };
      const res = await withSpy(() =>
        handle.request(fixtureName, {
          method: meta.route!.method,
          path: req.path,
          ...(body !== undefined ? { body } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        }),
      );
      return { status: res.status, body: res.body, trace: res.trace as unknown as HarnessTrace | null };
    },

    async rawRequest(req) {
      if (transport === null) throw new AverriRuntimeError("bad-config", "rawRequest needs the entry module to export the app as `default` or `app`");
      const t = transport;
      const url = new URL(req.path, "http://averri.local").toString();
      return withSpy(() => t.send({ method: req.method as HttpMethod, url, headers: { ...(req.headers ?? {}) }, body: req.body }));
    },

    async policyDecision(owner, fixtureName, input) {
      const decl = endpoint(owner);
      const meta = averriMeta(decl);
      if (meta.public) return "public";
      const actor = (fixtureOf(fixtureName).actor ?? null) as Actor | null;
      if (actor === null) return "unauthenticated";
      const policy = (decl.options as { policy?: PolicyDecl }).policy;
      if (policy === undefined || !isDeclaration(policy)) return "deny";
      if (averriMeta(policy).tier === "guard") return "opaque";
      const parsed = parse(decl, input);
      const verdict = await evaluatePolicy(policy, { input: parsed.ok ? parsed.value : input, actor }, { prisma, guardPrisma: prisma });
      return verdict.allow ? "allow" : "deny";
    },

    parseInput(owner, raw) {
      return parse(endpoint(owner), raw);
    },

    conformInput(owner, raw) {
      return conformInput((endpoint(owner).options as { input?: unknown }).input, raw, sampling);
    },

    actor(fixtureName) {
      return (fixtureOf(fixtureName).actor ?? null) as Record<string, unknown> | null;
    },

    prisma: prisma as unknown as Record<string, HarnessModel>,

    async snapshot(models) {
      const out: Record<string, unknown[]> = {};
      const client = prisma as unknown as Record<string, HarnessModel | undefined>;
      for (const name of models) {
        const model = client[name];
        if (model === undefined) throw new AverriRuntimeError("unknown-model", `Prisma client has no model accessor "${name}"`);
        try {
          out[name] = await model.findMany({ orderBy: { id: "asc" } });
        } catch {
          // no single `id` column: deterministic order by canonical row content
          const rows = await model.findMany();
          out[name] = rows.map((r) => [JSON.stringify(toJsonValue(r)), r] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
        }
      }
      return out;
    },

    emitted() {
      return lastEmitted;
    },

    async consumerRegistered(event, workflow) {
      const decl = byId.get(workflow);
      if (decl === undefined || decl.kind !== "workflow") return false;
      const meta = averriMeta(decl as WorkflowDecl);
      if (meta.on !== (event as EventId)) return false;
      const bare = event.startsWith("Event:") ? event.slice("Event:".length) : event;
      const prefix = config.emitter?.eventNamePrefix ?? "";
      const name = `${prefix}${bare}`;
      const declared = runnerEvents((decl as WorkflowDecl).options.runner);
      if (declared !== null && !declared.includes(name)) return false;
      const target = config.emitter?.spy.target;
      const listeners = target === undefined ? null : listenerCount(target, name);
      if (listeners !== null) return listeners > 0;
      // The emitter is not inspectable (no subscriberCount/listenerCount). The declaration's own `on` is
      // not evidence (the compiler already knows it), so only a runner that names the event counts. A
      // runner with no recognisable event name cannot be verified and fails closed (D-41i).
      return declared !== null && declared.includes(name);
    },

    async invariantViolations(entity) {
      const decl = byId.get(entity);
      if (decl === undefined || decl.kind !== "entity") throw new AverriRuntimeError("bad-declaration", `${entity} is not an entity declaration exported by \`modules\``);
      const meta = averriMeta(decl as EntityDecl);
      if (meta.contracts.length === 0) return [];
      const client = prisma as unknown as Record<string, HarnessModel | undefined>;
      const model = client[meta.clientName];
      if (model === undefined) throw new AverriRuntimeError("unknown-model", `Prisma client has no model accessor "${meta.clientName}"`);
      const violations: Array<{ contract: string; row: unknown }> = [];
      for (const row of await model.findMany()) {
        const result = await evaluateInvariants(meta.contracts, row as Row, { prisma, guardPrisma: prisma });
        for (const record of result.records) if (!record.ok) violations.push({ contract: record.contract, row: toJsonValue(row) });
      }
      return violations;
    },

    async close() {
      await observed?.close();
      await transport?.close();
      if (ownsPrisma && prisma !== null) {
        const disconnect = (prisma as { $disconnect?: () => Promise<void> }).$disconnect;
        if (typeof disconnect === "function") await disconnect.call(prisma);
      }
    },
  };
  return harness;
}
