/**
 * The declared-mode pipeline (SPEC-DECLARATIONS §5.3, SPEC-CONTRACTS §8), the single normative order:
 *
 * ```
 * validate (Zod)                → 400 ValidationFailed
 * authorize (plain client)      → 401 Unauthenticated (actor null, not public) · 403 Forbidden (policy denied)
 * [tx begin]                      when transaction !== false
 *   load subject (self) + include relations used by owned-list ops; snapshot old
 *   requires                    → 412 PreconditionFailed (all evaluated: tier 1, tier 2, guards with the plain client)
 *   run(ctx)                    → 500 HandlerError on throw (tx rolled back)
 *   reload subject (self after)
 *   ensures + invariants        → 500 PostconditionFailed (tx rolled back; `committed: true` without a transaction)
 * [tx commit]
 * emit buffered events            after commit; failure is trace-only (D-12)
 * ```
 *
 * One `ActionTrace` is recorded per invocation.
 */
import {
  AUTHENTICATION_FAILURE,
  PHASE_FAILURE,
  SUCCESS_STATUS,
  averriMeta,
  isDeclaration,
  isEventDecl,
  type ActionTrace,
  type Actor,
  type ActorOf,
  type AnyActionDecl,
  type AnyQueryDecl,
  type AverriConfig,
  type AverriMetaOf,
  type ContractRecord,
  type ContractViolationBody,
  type Declaration,
  type EmitterConfig,
  type EntityDecl,
  type EventDecl,
  type HandleResult,
  type Phase,
  type PhaseRecord,
  type PolicyDecl,
  type SubjectMeta,
} from "@averri/core";
import { stableHash, type ContractExpr, type EventId, type PolicyId } from "@averri/ir";
import { evaluateInvariants, evaluatePhase, evaluatePolicy, type ContractPhaseRecord } from "./contracts.js";
import { AverriRuntimeError, errorMessage } from "./errors.js";
import { elapsed } from "./guards.js";
import { compileWhere, modelOf } from "./predicates.js";
import { actorSummary, currentVitestTest, defaultTraceRecorder, newTraceId, type TraceRecorder } from "./trace.js";
import type { EvalEnv, EvaluatedEntry, PrismaLike, Row, TransactionFn } from "./types.js";
import { deepCopy, isRecord, serializeResult, toJsonValue } from "./values.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RuntimeOptions {
  /** The project's Prisma client (plain, non-transactional). */
  prisma: PrismaLike;
  /** `averri.config.ts` (for `emitter` and production `sampling`). Null/absent: no emitter, no sampling. */
  config?: AverriConfig | null;
  /** Other declarations, used to resolve entity NAMES (`subject.entity: "Invitation"`, `output: "Invitation"`) to their invariants. */
  declarations?: readonly Declaration[];
  /** Trace sink. `undefined` → the process-wide file recorder in `.averri/traces`; `null` → no recording. */
  recorder?: TraceRecorder | null;
  /** Production switch for sampling. Default `process.env.NODE_ENV === "production"`. */
  production?: boolean;
  /** Random source for sampling (tests). */
  random?: () => number;
  now?: () => Date;
  /** Success status. Default {@link SUCCESS_STATUS}. */
  status?: number;
}

export interface InvokeOptions extends RuntimeOptions {
  input: unknown;
  actor: Actor | null;
  /** Reproduction info for the trace (adapters fill it). */
  request?: ActionTrace["request"];
  /** Vitest test info; default `expect.getState()` under Vitest. */
  test?: ActionTrace["test"];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ZodLike {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues?: unknown[]; message?: string } };
}

interface ActionOptionsLike {
  input: ZodLike;
  policy?: PolicyDecl;
  subject?: { entity: EntityDecl | string };
  output?: unknown;
  run?: (ctx: unknown) => unknown;
}

interface EmitEntry {
  event: EventDecl;
  payload: Record<string, unknown>;
}

interface FailureInfo {
  status: number;
  error: ContractViolationBody["error"];
  contract?: string;
  evaluated?: Record<string, EvaluatedEntry>;
  message: string;
}

/** Thrown inside the pipeline to abort with a phase failure; never escapes `invoke`. */
export class PhaseFailure extends Error {
  readonly phase: Phase;
  readonly info: FailureInfo;
  constructor(phase: Phase, info: FailureInfo) {
    super(info.message);
    this.phase = phase;
    this.info = info;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampled(rate: number, random: () => number): boolean {
  return rate >= 1 || (rate > 0 && random() < rate);
}

function formatIssues(error: { issues?: unknown[]; message?: string }): string {
  const issues = Array.isArray(error.issues) ? error.issues : [];
  const parts = issues.slice(0, 5).map((issue) => {
    const i = issue as { path?: unknown[]; message?: string };
    const path = Array.isArray(i.path) && i.path.length > 0 ? i.path.join(".") : "(root)";
    return `${path}: ${i.message ?? "invalid"}`;
  });
  return parts.length > 0 ? parts.join("; ") : (error.message ?? "invalid input");
}

/** Resolves an entity reference (declaration or model name) to its invariant records. */
export function entityInvariants(entity: EntityDecl | string | undefined, declarations: readonly Declaration[] | undefined): readonly ContractRecord[] {
  if (entity === undefined) return [];
  if (typeof entity !== "string") {
    return isDeclaration(entity) && entity.kind === "entity" ? averriMeta(entity).contracts : [];
  }
  if (entity === "void") return [];
  for (const decl of declarations ?? []) {
    if (decl.kind === "entity" && decl.name === entity && isDeclaration(decl)) return averriMeta(decl).contracts;
  }
  return [];
}

/** The entity behind `output` (a declaration or a PascalCase name), or undefined for Zod/void outputs. */
export function outputEntity(output: unknown): EntityDecl | string | undefined {
  if (output === undefined || output === "void") return undefined;
  if (typeof output === "string") return output;
  if (isDeclaration(output) && output.kind === "entity") return output;
  return undefined;
}

/** Owned-list paths (`exists`/`count`/`sum` over `self.*`/`old.*`) as segment lists after the root. */
export function ownedListPaths(records: readonly ContractRecord[]): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const n = node as { op?: unknown; path?: { ref?: unknown } };
    if ((n.op === "exists" || n.op === "count" || n.op === "sum") && typeof n.path?.ref === "string") {
      const segments = n.path.ref.split(".");
      if ((segments[0] === "self" || segments[0] === "old") && segments.length > 1) {
        const key = segments.slice(1).join(".");
        if (!seen.has(key)) {
          seen.add(key);
          out.push(segments.slice(1));
        }
      }
    }
    for (const value of Object.values(node as Record<string, unknown>)) visit(value);
  };
  for (const record of records) if (record.expr !== null) visit(record.expr as ContractExpr);
  return out;
}

/** Prisma `include` tree for nested relation paths: `[["lines"], ["order","items"]]` → `{ lines: true, order: { include: { items: true } } }`. */
export function includeTree(paths: readonly string[][]): Record<string, unknown> | undefined {
  if (paths.length === 0) return undefined;
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    let level = root;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i] as string;
      const last = i === path.length - 1;
      const existing = level[segment];
      if (last) {
        if (existing === undefined) level[segment] = true;
        continue;
      }
      if (typeof existing === "object" && existing !== null) {
        level = (existing as { include: Record<string, unknown> }).include;
      } else {
        const next: Record<string, unknown> = {};
        level[segment] = { include: next };
        level = next;
      }
    }
  }
  return root;
}

/** Wraps a client so calls on model accessors are counted (for `PhaseRecord.run.dbCalls`). `$`-methods pass through bound. */
export function countingClient(client: PrismaLike, counter: { n: number }): PrismaLike {
  const target = client as Record<string, unknown>;
  return new Proxy(client, {
    get(_t, prop) {
      const value = target[prop as string];
      if (typeof prop !== "string" || prop.startsWith("$") || prop.startsWith("_")) {
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
      }
      if (typeof value === "object" && value !== null) {
        const model = value as Record<string, unknown>;
        return new Proxy(value, {
          get(_m, p) {
            const member = model[p as string];
            if (typeof member === "function") {
              return (...args: unknown[]) => {
                counter.n += 1;
                return (member as (...a: unknown[]) => unknown).apply(value, args);
              };
            }
            return member;
          },
        });
      }
      return value;
    },
  });
}

interface LoadedSubject {
  row: Row | null;
  ambiguous: boolean;
}

async function loadSubject(subject: SubjectMeta, env: EvalEnv, client: PrismaLike, include: Record<string, unknown> | undefined): Promise<LoadedSubject> {
  const compiled = compileWhere(subject.where, env);
  if (compiled.undefinedRefs.length > 0) return { row: null, ambiguous: false };
  const args: { where: unknown; take: number; include?: unknown } = { where: compiled.where, take: 2 };
  if (include !== undefined) args.include = include;
  const rows = await modelOf(client, subject.clientName).findMany(args);
  if (rows.length > 1) return { row: null, ambiguous: true };
  return { row: rows[0] ?? null, ambiguous: false };
}

async function publishEvents(buffer: readonly EmitEntry[], emitter: EmitterConfig | null): Promise<Extract<PhaseRecord, { phase: "emit" }>> {
  const events = buffer.map((entry) => ({ event: entry.event.id as EventId, payloadHash: stableHash(toJsonValue(entry.payload) ?? null) }));
  if (buffer.length === 0) return { phase: "emit", ok: true, events };
  if (emitter === null) return { phase: "emit", ok: false, events, error: "no emitter configured (config.emitter is null) but events were emitted" };
  try {
    for (const entry of buffer) {
      await emitter.publish(`${emitter.eventNamePrefix}${entry.event.name}`, entry.payload);
    }
    return { phase: "emit", ok: true, events };
  } catch (error) {
    return { phase: "emit", ok: false, events, error: errorMessage(error) };
  }
}

function validateInput(schema: ZodLike, raw: unknown, phases: PhaseRecord[]): unknown {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    phases.push({ phase: "validate", ok: true });
    return parsed.data;
  }
  phases.push({ phase: "validate", ok: false, issues: Array.isArray(parsed.error.issues) ? (toJsonValue(parsed.error.issues) as unknown[]) : [] });
  throw new PhaseFailure("validate", { status: PHASE_FAILURE.validate.status, error: PHASE_FAILURE.validate.error, message: formatIssues(parsed.error) });
}

async function authorize(
  meta: { public: boolean; policy: PolicyId | null },
  policyDecl: PolicyDecl | undefined,
  input: unknown,
  actor: Actor | null,
  prisma: PrismaLike,
  phases: PhaseRecord[],
): Promise<void> {
  if (meta.public) {
    phases.push({ phase: "authorize", ok: true, policy: null, decision: "public", observed: false });
    return;
  }
  if (actor === null || actor === undefined) {
    phases.push({ phase: "authorize", ok: false, policy: meta.policy, decision: "unauthenticated", observed: false });
    throw new PhaseFailure("authorize", {
      status: AUTHENTICATION_FAILURE.status,
      error: AUTHENTICATION_FAILURE.error,
      message: "authentication required: actor is null and the declaration is not public",
    });
  }
  if (policyDecl === undefined || !isDeclaration(policyDecl) || policyDecl.kind !== "policy") {
    throw new AverriRuntimeError("bad-declaration", `declaration has policy ${String(meta.policy)} but options.policy is not a policy() declaration`);
  }
  const verdict = await evaluatePolicy(policyDecl, { input, actor }, { prisma, guardPrisma: prisma });
  phases.push({ phase: "authorize", ok: verdict.allow, policy: meta.policy, decision: verdict.allow ? "allow" : "deny", observed: false });
  if (!verdict.allow) {
    throw new PhaseFailure("authorize", {
      status: PHASE_FAILURE.authorize.status,
      error: PHASE_FAILURE.authorize.error,
      contract: meta.policy ?? undefined,
      evaluated: verdict.tier === "guard" ? undefined : verdict.evaluated,
      message: `${meta.policy} denied: ${verdict.message || "policy evaluated to false"}`,
    });
  }
}

function violationBody(failure: PhaseFailure, useTx: boolean): ContractViolationBody {
  const body: ContractViolationBody = { error: failure.info.error, message: failure.info.message };
  if (failure.info.contract !== undefined) body.contract = failure.info.contract;
  if (failure.info.evaluated !== undefined) body.evaluated = failure.info.evaluated;
  if (failure.phase === "ensures" && !useTx) body.committed = true;
  return body;
}

function committedAfter(phase: Phase, useTx: boolean): boolean {
  if (phase === "emit") return true;
  return !useTx && (phase === "run" || phase === "ensures");
}

// ---------------------------------------------------------------------------
// invoke
// ---------------------------------------------------------------------------

/** Runs one declared-mode invocation end to end and records its trace. Never throws for contract violations. */
export async function invoke<D extends AnyActionDecl | AnyQueryDecl>(decl: D, options: InvokeOptions): Promise<HandleResult> {
  const meta = averriMeta(decl) as AverriMetaOf<"action"> | AverriMetaOf<"query">;
  if (meta.mode !== "declared") {
    throw new AverriRuntimeError("bad-declaration", `${meta.id} is an observe-mode declaration (no run); use observe() under Vitest`);
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const t0 = performance.now();
  const phases: PhaseRecord[] = [];
  const opts = decl.options as unknown as ActionOptionsLike;
  const prisma = options.prisma;
  if (prisma === null || prisma === undefined || typeof prisma !== "object") {
    throw new AverriRuntimeError("no-prisma", `invoke(${meta.id}): options.prisma is required`);
  }
  const actor = options.actor ?? null;
  const useTx = meta.kind === "action" && meta.transaction !== false;
  const txOptions = meta.kind === "action" && typeof meta.transaction === "object" ? meta.transaction : undefined;
  const txFn = (prisma as { $transaction?: unknown }).$transaction;
  if (useTx && typeof txFn !== "function") {
    throw new AverriRuntimeError("no-transaction", `${meta.id} declares a transaction but the Prisma client has no $transaction(); pass transaction: false or a real client`);
  }
  const random = options.random ?? Math.random;
  const production = options.production ?? process.env.NODE_ENV === "production";
  const sampling = options.config?.sampling ?? { ensures: 0, invariants: 0 };
  const ensuresOn = production ? sampled(sampling.ensures, random) : true;
  const invariantsOn = production ? sampled(sampling.invariants, random) : true;
  const buffer: EmitEntry[] = [];
  let result: unknown;
  let failure: PhaseFailure | null = null;

  const emit = (event: EventDecl, payload: Record<string, unknown>): void => {
    if (!isEventDecl(event)) throw new AverriRuntimeError("bad-declaration", "emit(): first argument must be an event() declaration");
    buffer.push({ event, payload: payload ?? {} });
  };

  try {
    const input = validateInput(opts.input, options.input, phases);
    await authorize(meta, opts.policy, input, actor, prisma, phases);
    if (typeof opts.run !== "function") throw new AverriRuntimeError("bad-declaration", `${meta.id} has no run()`);
    const run = opts.run;

    if (meta.kind === "query") {
      const counter = { n: 0 };
      const runStarted = performance.now();
      try {
        result = await run({ input, actor, db: countingClient(prisma, counter) });
      } catch (error) {
        phases.push({ phase: "run", ok: false, durationMs: elapsed(runStarted), dbCalls: counter.n, error: errorMessage(error) });
        throw new PhaseFailure("run", { status: PHASE_FAILURE.run.status, error: PHASE_FAILURE.run.error, message: `run threw: ${errorMessage(error)}` });
      }
      phases.push({ phase: "run", ok: true, durationMs: elapsed(runStarted), dbCalls: counter.n });
    } else {
      const requires = meta.contracts.filter((c) => c.phase === "requires");
      const ensures = meta.contracts.filter((c) => c.phase === "ensures");
      const subjectInvariants = meta.subject ? entityInvariants(opts.subject?.entity, options.declarations) : [];
      const outEntity = outputEntity(opts.output);
      const outputInvariants = entityInvariants(outEntity, options.declarations);
      const include = includeTree(ownedListPaths([...requires, ...ensures, ...subjectInvariants]));

      const body = async (tx: PrismaLike): Promise<void> => {
        let self: Row | null = null;
        let old: Row | null = null;
        if (meta.subject !== null) {
          const loaded = await loadSubject(meta.subject, { input, actor }, tx, include);
          if (loaded.ambiguous) {
            const contract = `Contract:${meta.id.slice("Action:".length)}.requires.$subject`;
            phases.push({ phase: "requires", ok: false, contract, tier: "predicate", durationMs: 0 });
            throw new PhaseFailure("requires", {
              status: PHASE_FAILURE.requires.status,
              error: PHASE_FAILURE.requires.error,
              contract,
              message: `${contract} failed: subject.where selects more than one ${meta.subject.model} row`,
            });
          }
          self = loaded.row;
          old = deepCopy(self);
        }
        const req = await evaluatePhase("requires", requires, { input, actor, self, old }, { prisma: tx, guardPrisma: prisma });
        phases.push(...req.records);
        if (req.firstFailure !== null) {
          throw new PhaseFailure("requires", { status: PHASE_FAILURE.requires.status, error: PHASE_FAILURE.requires.error, ...req.firstFailure });
        }
        const counter = { n: 0 };
        const runStarted = performance.now();
        try {
          result = await run({ input, actor, tx: countingClient(tx, counter), self, emit });
        } catch (error) {
          phases.push({ phase: "run", ok: false, durationMs: elapsed(runStarted), dbCalls: counter.n, error: errorMessage(error) });
          throw new PhaseFailure("run", { status: PHASE_FAILURE.run.status, error: PHASE_FAILURE.run.error, message: `run threw: ${errorMessage(error)}` });
        }
        phases.push({ phase: "run", ok: true, durationMs: elapsed(runStarted), dbCalls: counter.n });
        let after: Row | null = self;
        if (meta.subject !== null) after = (await loadSubject(meta.subject, { input, actor }, tx, include)).row;
        const emitted = buffer.map((entry) => entry.event.id as EventId);
        if (ensuresOn && ensures.length > 0) {
          const ens = await evaluatePhase("ensures", ensures, { input, actor, self: after, old, result, emitted }, { prisma: tx, guardPrisma: prisma });
          phases.push(...ens.records);
          if (ens.firstFailure !== null) {
            throw new PhaseFailure("ensures", { status: PHASE_FAILURE.ensures.status, error: PHASE_FAILURE.ensures.error, ...ens.firstFailure });
          }
        }
        if (invariantsOn) {
          const checks: Array<{ records: readonly ContractRecord[]; row: Row }> = [];
          if (after !== null && subjectInvariants.length > 0) checks.push({ records: subjectInvariants, row: after });
          if (outputInvariants.length > 0 && isRecord(result)) checks.push({ records: outputInvariants, row: result });
          for (const check of checks) {
            const inv = await evaluateInvariants(check.records, check.row, { prisma: tx, guardPrisma: prisma });
            phases.push(...inv.records);
            if (inv.firstFailure !== null) {
              throw new PhaseFailure("ensures", { status: PHASE_FAILURE.ensures.status, error: PHASE_FAILURE.ensures.error, ...inv.firstFailure });
            }
          }
        }
      };

      if (useTx) {
        await (txFn as TransactionFn).call(prisma, body, txOptions);
      } else {
        await body(prisma);
      }
      phases.push(await publishEvents(buffer, options.config?.emitter ?? null));
    }
  } catch (error) {
    failure = error instanceof PhaseFailure ? error : new PhaseFailure("run", { status: PHASE_FAILURE.run.status, error: PHASE_FAILURE.run.error, message: errorMessage(error) });
    if (!(error instanceof PhaseFailure) && !phases.some((p) => p.phase === "run")) {
      phases.push({ phase: "run", ok: false, durationMs: 0, dbCalls: 0, error: errorMessage(error) });
    }
  }

  const emitRecord = phases.find((p): p is Extract<PhaseRecord, { phase: "emit" }> => p.phase === "emit");
  let status: number;
  let body: unknown;
  if (failure !== null) {
    status = failure.info.status;
    body = violationBody(failure, useTx);
  } else {
    status = options.status ?? SUCCESS_STATUS;
    body = serializeResult(result);
  }
  const outcome: ActionTrace["outcome"] =
    failure !== null
      ? {
          ok: false,
          phase: failure.phase,
          ...(failure.info.contract !== undefined ? { contract: failure.info.contract } : {}),
          message: failure.info.message,
          committed: committedAfter(failure.phase, useTx),
        }
      : emitRecord !== undefined && !emitRecord.ok
        ? { ok: false, phase: "emit", message: emitRecord.error ?? PHASE_FAILURE.emit.error, committed: true }
        : { ok: true };
  const trace: ActionTrace = {
    traceId: newTraceId(),
    action: meta.id,
    mode: "declared",
    startedAt: startedAt.toISOString(),
    durationMs: elapsed(t0),
    actor: actorSummary(actor),
    phases,
    outcome,
  };
  if (options.request !== undefined) trace.request = options.request;
  const test = options.test ?? (await currentVitestTest());
  if (test !== undefined) trace.test = test;
  const recorder = options.recorder === undefined ? defaultTraceRecorder() : options.recorder;
  if (recorder !== null) {
    try {
      recorder.record(trace);
    } catch {
      // trace recording never changes the response
    }
  }
  return { status, body, trace };
}

/** Framework-neutral pipeline for one declaration: `(input, actor) => HandleResult` (core `DeclaredRuntime.handle`). */
export function handle<D extends AnyActionDecl | AnyQueryDecl>(decl: D, runtime: RuntimeOptions): (input: unknown, actor: ActorOf<D>) => Promise<HandleResult> {
  const meta = averriMeta(decl) as AverriMetaOf<"action"> | AverriMetaOf<"query">;
  if (meta.mode !== "declared") {
    throw new AverriRuntimeError("bad-declaration", `${meta.id} is an observe-mode declaration (no run); use observe() under Vitest`);
  }
  return (input, actor) => invoke(decl, { ...runtime, input, actor: (actor ?? null) as Actor | null });
}

export type { ContractPhaseRecord };
