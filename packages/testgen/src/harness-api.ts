/**
 * The test-support surface generated tests import from `@averri/contracts`.
 *
 * This file is TYPES ONLY (plus `declare` signatures). It is the contract between `@averri/testgen`
 * (which emits code against it) and `@averri/contracts` (which implements it). The emitted-code
 * typecheck test maps `@averri/contracts` onto this file, so a change here must be mirrored in
 * `@averri/contracts`' real exports. Everything is structural: `AverriConfig`, `ActionTrace` and the
 * Prisma client are typed loosely so this file depends on nothing but the IR ids.
 */

export interface HarnessInit {
  /** The default export of `averri.config.ts` (`AverriConfig`). */
  config: object;
  /** Module namespace of the configured entry point; the harness uses `default` or `app` (observe mode). May be omitted for declared-mode-only owners. */
  app?: Record<string, unknown> | null;
  /** Module namespaces whose exports include every declaration the file references; resolved by `averriMeta(decl).id`. */
  modules: ReadonlyArray<Record<string, unknown>>;
  /** Optional explicit Prisma client; default `new PrismaClient()` from the project's `@prisma/client`. */
  prisma?: object;
}

export interface PhaseLike {
  phase: string;
  ok: boolean;
  /** `requires`/`ensures` records: the Contract id. */
  contract?: string;
  policy?: string | null;
  decision?: string;
  /** `emit` record: events emitted by the invocation. */
  events?: ReadonlyArray<{ event: string; payloadHash: string }>;
}

export interface TraceLike {
  phases: ReadonlyArray<PhaseLike>;
  outcome: { ok: boolean; phase?: string; contract?: string; message?: string };
}

export interface InvokeResult {
  status: number;
  body: unknown;
  /** Null when no declaration matched (observe mode) or the harness could not record one. */
  trace: TraceLike | null;
}

export interface RawRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** Sent verbatim (never re-serialised): the raw-body pitfall depends on it. */
  body?: string;
}

export type PolicyDecision = "allow" | "deny" | "unauthenticated" | "public" | "opaque";

export interface PrismaModelLike {
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findFirst(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> }): Promise<Array<Record<string, unknown>>>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface AverriTestHarness {
  /**
   * Invoke the Action/Query `owner` as the named actor fixture. Declared mode: `handle(decl)(input, actor)`;
   * observe mode: a request to the declared route (path params taken from `input` by name, the rest as
   * body or query) with the fixture's headers, through `observe(app, ...)`.
   */
  invoke(owner: string, fixture: string, input: unknown, options?: { headers?: Record<string, string> }): Promise<InvokeResult>;
  /** A raw HTTP request to the app at the fetch boundary (webhook pitfalls). */
  rawRequest(req: RawRequest): Promise<{ status: number; body: unknown }>;
  /** Evaluate the owner's policy AST against the fixture's actor and the input (predicates hit the test database). */
  policyDecision(owner: string, fixture: string, input: unknown): Promise<PolicyDecision>;
  /** Parse `raw` with the owner's declared Zod input schema. */
  parseInput(owner: string, raw: unknown): { ok: boolean; value?: unknown; issues?: unknown };
  /**
   * `raw` made acceptable to the owner's Zod input schema with minimal change: fields the schema
   * accepts are kept, optional fields it rejects are dropped, required ones are re-sampled from the
   * schema. Returns the raw (unparsed) input to send, or null when the schema cannot be sampled.
   */
  conformInput(owner: string, raw: unknown): Record<string, unknown> | null;
  /** `config.actors[fixture].actor`. */
  actor(fixture: string): Record<string, unknown> | null;
  /** The project's Prisma client, indexed by client accessor name. */
  prisma: Record<string, PrismaModelLike>;
  /** `findMany` of every listed client accessor, ordered by `@id`, keyed by accessor. */
  snapshot(models: ReadonlyArray<string>): Promise<Record<string, unknown[]>>;
  /** Emissions captured during the last `invoke` (the `emit` buffer in declared mode; `config.emitter.spy` calls in observe mode). */
  emitted(): ReadonlyArray<{ event: string; payload: unknown }>;
  /** True when the workflow's runner is registered for `config.emitter.eventNamePrefix + eventName`. */
  consumerRegistered(event: string, workflow: string): Promise<boolean>;
  /** Evaluate every invariant of the entity over `findMany()` of its model; empty when all hold. */
  invariantViolations(entity: string): Promise<ReadonlyArray<{ contract: string; row: unknown }>>;
  close(): Promise<void>;
}

export declare function createTestHarness(init: HarnessInit): Promise<AverriTestHarness>;
