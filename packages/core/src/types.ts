/**
 * @averr/core — public declaration API surface (types only).
 *
 * This file defines what a user (human or agent) sees when they write
 * `import { entity, policy, action, query, event, workflow, integration, e, db } from "@averr/core"`
 * and `import { defineConfig } from "@averr/core"`.
 * It contains NO runtime. The runtime implementation lives in `index.ts` (later task) and in
 * `@averr/contracts`; both MUST conform to these types.
 *
 * Design rules (see docs/SPEC-DECLARATIONS.md):
 * - Seven constructs plus two builders, one spelling each, no sugar, no string mini-DSLs.
 * - Every option whose value set is closed is a literal union so tsc rejects hallucinated values.
 * - Contracts are built with `e.*` / `db.*` into the serializable AST from `@averr/ir`; a bare
 *   async function `(ctx) => boolean` is the only opaque escape hatch (tier "guard") and is
 *   distinguishable from analysable clauses by type (`typeof clause === "function"`).
 * - The project's own Prisma client is used in handlers; Averr never wraps data access.
 * - Declarations are LOWERED STATICALLY by the compiler with ts-morph. Nothing in this module has
 *   import-time side effects, and the compiler never imports @averr/core or evaluates user modules.
 */

import type { z } from "zod";
import type {
  BoolExpr,
  DbCountWhere,
  DbWhere,
  Effect,
  EventId,
  HttpMethod,
  IdempotencySpec,
  LenExpr,
  Lit,
  LitScalar,
  Operand,
  PayloadType,
  Ref,
  RefPath,
  RetrySpec,
  RouteSpec,
  WebhookScheme,
  WorkflowEngine,
} from "@averr/ir";

export type { Effect, HttpMethod, RouteSpec, PayloadType, WorkflowEngine, RetrySpec, IdempotencySpec, WebhookScheme } from "@averr/ir";

// ---------------------------------------------------------------------------
// 1. Project-provided types (module augmentation)
// ---------------------------------------------------------------------------

/**
 * Augment this interface from your project to type `actor`, `tx` and model names. `averr init`
 * writes this block to `src/averr.d.ts`; the worked examples in the specs ASSUME it exists
 * (`actor.orgId` is otherwise `unknown`).
 *
 * ```ts
 * import type { PrismaClient, Prisma } from "@prisma/client";
 * declare module "@averr/core" {
 *   interface AverrTypes {
 *     Actor: { id: string; orgId: string; role: "owner" | "admin" | "member" };
 *     PrismaClient: PrismaClient;
 *     TransactionClient: Prisma.TransactionClient;
 *     ModelName: Uncapitalize<Prisma.ModelName>;
 *   }
 * }
 * ```
 * Without augmentation every slot falls back to a permissive default so the library works on day one.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AverrTypes {}

type Slot<K extends string, Default> = K extends keyof AverrTypes ? AverrTypes[K] : Default;

/** The authenticated principal. Default shape has only `id`; augment `AverrTypes.Actor` for more. */
export type Actor = Slot<"Actor", { id: string; [key: string]: unknown }>;

/** The project's Prisma client (non-transactional). */
export type PrismaClientLike = Slot<"PrismaClient", Record<string, unknown>>;

/** The client passed to `run` inside `$transaction`. Same type as PrismaClientLike unless augmented. */
export type TxClient = Slot<"TransactionClient", PrismaClientLike>;

/** Prisma client accessor names (`"invitation"`, `"membership"`). Default `string`. */
export type ModelName = Slot<"ModelName", string>;

// ---------------------------------------------------------------------------
// 2. Identifier shapes (template-literal "brands")
// ---------------------------------------------------------------------------

/**
 * Id for action(), query() and policy(): `<Scope>.<name>`, Scope PascalCase, exactly one dot.
 * Examples: `"Team.inviteMember"`, `"Team.OwnerOrAdmin"`. The string IS the durable identity.
 */
export type DeclaredId = `${Capitalize<string>}.${string}`;

/** Name for entity(), event(), workflow(), integration(): PascalCase, no dots. Entity names MUST equal the Prisma model name. */
export type PascalName = Capitalize<string>;

// ---------------------------------------------------------------------------
// 3. Contract clauses: the three tiers as three distinct types
// ---------------------------------------------------------------------------

/**
 * Tier 1. Built only from `e.*` without any `db.*` node. Fully analysable: the compiler can
 * generate a violating fast-check arbitrary per clause, compute impact, and report evaluated LHS/RHS.
 */
export interface ExprClause {
  readonly tier: "expr";
  readonly ast: BoolExpr;
}

/**
 * Tier 2. Contains at least one `db.*` predicate. Compiles to a Prisma query at runtime and to a
 * fixture generator for tests. Still serializable and still shown as "verified" in spec cards.
 */
export interface PredicateClause {
  readonly tier: "predicate";
  readonly ast: BoolExpr;
}

export type AnalysableClause = ExprClause | PredicateClause;

/**
 * Context passed to a tier-3 guard.
 * - `input` is the validated input (typed from the action's Zod schema).
 * - `actor` is `Actor` for policy-protected declarations and `Actor | null` for `public: true` ones.
 * - `result` is present only in `ensures`; it is typed `unknown` there (narrow it, or prefer `e.result()`),
 *   because typing it from `run` would fix the action's output type before `run` is inferred.
 * - `self`/`old` are present only when the action declares `subject`.
 * - `prisma` is the NON-transactional client. Guards MUST NOT write.
 */
export interface GuardContext<Input = unknown, Result = unknown, A extends Actor | null = Actor> {
  input: Input;
  actor: A;
  self: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  result: Result | undefined;
  prisma: PrismaClientLike;
}

/**
 * Tier 3 ("guard"). A bare async predicate written directly as a `requires`/`ensures`/`allow` value.
 * Traced, enforced in observe (test-time) and declared modes, listed as "opaque guard" in spec cards,
 * excluded from test generation and static impact. The compiler counts guards; the ratio is a
 * health metric in `overview`. There is no `guard()` wrapper (docs/SPEC-DECISIONS.md D-1).
 */
export type GuardFn<Input = unknown, Result = unknown, A extends Actor | null = Actor> = (
  ctx: GuardContext<Input, Result, A>,
) => boolean | Promise<boolean>;

/** Supertype of every guard (parameters are contravariant, hence `never`). Use for "any clause" positions. */
export type AnyGuardFn = GuardFn<never, never, never>;

/** Any clause of any tier. Runtime discrimination: `typeof clause === "function"` is tier "guard". */
export type Clause = AnalysableClause | AnyGuardFn;

/** A value-typed operand produced by `e.input()`, `e.actor()`, `e.self()`, `e.old()`, `e.result()`. */
export interface RefValue {
  readonly tier: "value";
  readonly ast: Ref;
}

/** A scalar-valued operand: a ref, `e.lit()` or `e.len()`. The only operands allowed inside `where` operator forms. */
export interface ScalarValue {
  readonly tier: "value";
  readonly ast: Ref | Lit | LenExpr;
}

/** Any value-typed operand (`e.sum()`, `e.count()` included). */
export interface Value {
  readonly tier: "value";
  readonly ast: Operand;
}

/** A value-typed operand produced by `db.countWhere()`; forces the enclosing clause to tier "predicate". */
export interface DbValue {
  readonly tier: "dbvalue";
  readonly ast: DbCountWhere;
}

// ---------------------------------------------------------------------------
// 4. Reference paths accepted by the builders
// ---------------------------------------------------------------------------

/**
 * Left-hand-side path strings. A bare field name means `self.<field>` (inside `invariant`: the row).
 * Prefixed forms select the root explicitly. Max 3 segments after the root (A3004).
 *
 * `RefPath | (string & {})` keeps editor autocomplete for the five roots while accepting bare names.
 * DEVIATION from FINAL §4 ("tsc checks field names"): tsc does NOT check field names or roots; the
 * compiler does (A3002 unknown field, A3003 root/phase, A3010 misspelled root). A double prefix such as
 * `e.input("input.teamId")` is not normalised; it is A3002 with a deterministic fix that strips the prefix.
 *
 * Phase rules (A3003): requires: input, actor, self · ensures: input, actor, self, result, old ·
 * invariant: self only (bare names) · policy allow: input, actor.
 */
export type Path = RefPath | (string & {});

/** What a comparison accepts on the left: a path string or a built value. */
export type Lhs = Path | Value | DbValue;
/** What a comparison accepts on the right: a built value or a literal. Strings on the right are ALWAYS literals. */
export type Rhs = Value | DbValue | LitScalar;

/**
 * Rejects ref-shaped string literals on the right (`e.eq("input.email", "result.email")` is a type error:
 * write `e.result("email")`). The compiler repeats the check as A3007 for strings tsc cannot see through.
 */
export type NoRefString<R> = R extends RefPath ? never : unknown;

/** Tier of a composite clause: "predicate" if any part is a predicate or db value, else "expr". */
export type TierOf<Parts> = Extract<Parts, PredicateClause | DbValue> extends never ? ExprClause : PredicateClause;

// ---------------------------------------------------------------------------
// 5. e.* expression builder
// ---------------------------------------------------------------------------

/**
 * Typed combinators that build the serializable AST. No lambda bodies are parsed; tsc checks the
 * shape, the compiler checks field names against the Prisma schema facts and the Zod output type (A3002).
 */
export interface ExpressionBuilder {
  /** Reference to a validated input field: `{ ref: "input.<field>" }`. */
  input(field: string): RefValue;
  /** Reference to an actor field: `{ ref: "actor.<field>" }`. */
  actor(field: string): RefValue;
  /** Reference to the subject row after run (or before, in requires): `{ ref: "self.<field>" }`. Requires `subject`. */
  self(field: string): RefValue;
  /** Reference to the subject row before run: `{ ref: "old.<field>" }`. ensures only; requires `subject`. */
  old(field: string): RefValue;
  /** Reference to the handler's return value: `{ ref: "result.<field>" }`. ensures only. */
  result(field: string): RefValue;
  /** Explicit literal, needed only when a literal must appear on the left. */
  lit(value: LitScalar): ScalarValue;

  eq<L extends Lhs, R extends Rhs>(lhs: L, rhs: R & NoRefString<R>): TierOf<L | R>;
  ne<L extends Lhs, R extends Rhs>(lhs: L, rhs: R & NoRefString<R>): TierOf<L | R>;
  lt<L extends Lhs, R extends Rhs>(lhs: L, rhs: R & NoRefString<R>): TierOf<L | R>;
  lte<L extends Lhs, R extends Rhs>(lhs: L, rhs: R & NoRefString<R>): TierOf<L | R>;
  gt<L extends Lhs, R extends Rhs>(lhs: L, rhs: R & NoRefString<R>): TierOf<L | R>;
  gte<L extends Lhs, R extends Rhs>(lhs: L, rhs: R & NoRefString<R>): TierOf<L | R>;

  /** At least one clause; guards are not accepted (a function is not an AnalysableClause). */
  and<A extends readonly [AnalysableClause, ...AnalysableClause[]]>(...clauses: A): TierOf<A[number]>;
  or<A extends readonly [AnalysableClause, ...AnalysableClause[]]>(...clauses: A): TierOf<A[number]>;
  not<C extends AnalysableClause>(clause: C): TierOf<C>;

  /** Membership in a literal list or a list-valued ref (`e.input("roles")`). */
  in<L extends Lhs>(lhs: L, list: readonly LitScalar[] | RefValue): TierOf<L>;
  isNull(path: Path | RefValue): ExprClause;

  /** Length of a string or owned list. */
  len(path: Path | RefValue): ScalarValue;
  /** Sum of `field` over an owned list reachable by `path` (depth <= 3). */
  sum(path: Path | RefValue, field: string): Value;
  /** Count of elements, optionally filtered; inside `where`, bare paths refer to the element. */
  count(path: Path | RefValue, where?: ExprClause): Value;
  /** True if some element satisfies `where` (or the list is non-empty). */
  exists(path: Path | RefValue, where?: ExprClause): ExprClause;

  /**
   * True if `event` was emitted by this invocation. A number means exactly that many;
   * omitted means at least once. ensures only (A3003 elsewhere).
   */
  emitted(event: EventDecl, count?: number | { min?: number; max?: number }): ExprClause;
}

// ---------------------------------------------------------------------------
// 6. db.* predicate builder
// ---------------------------------------------------------------------------

/**
 * Where-clause input as written by users. Nested objects follow TO-ONE relations (`user: { email: ... }`);
 * the BUILDER flattens them to dotted keys (depth <= 3) so the stored AST is always the canonical flat
 * `DbWhere`. Strings are literals; use `e.input()` etc. for refs. Operator forms take scalar operands only
 * (refs, literals, `e.len()`); `e.sum/count` and `db.countWhere` inside a where are A3009.
 * Fields literally named `in`, `not`, `lt`, `lte`, `gt`, `gte` cannot be addressed (A3002), as in Prisma.
 */
export type WhereInput = {
  readonly [field: string]:
    | ScalarValue
    | LitScalar
    | { readonly in: readonly LitScalar[] | RefValue }
    | { readonly not: ScalarValue | LitScalar }
    | { readonly lt: ScalarValue | LitScalar }
    | { readonly lte: ScalarValue | LitScalar }
    | { readonly gt: ScalarValue | LitScalar }
    | { readonly gte: ScalarValue | LitScalar }
    | WhereInput;
};

/**
 * Closed set of declarative DB predicates over Prisma models. Each compiles to one Prisma
 * `count` at runtime and to a fixture generator in tests. Refs inside `where` follow the
 * same phase rules as expressions. A ref that evaluates to `undefined` makes the predicate false
 * (or `countWhere` 0): Averr never lets Prisma drop a filter (SPEC-CONTRACTS §5).
 */
export interface DbPredicateBuilder {
  /** At least one row matches. */
  exists(model: ModelName, where: WhereInput): PredicateClause;
  /** No row matches. */
  none(model: ModelName, where: WhereInput): PredicateClause;
  /** Exactly one row matches. */
  unique(model: ModelName, where: WhereInput): PredicateClause;
  /** Number of matching rows, for use in comparisons: `e.lte(db.countWhere("membership", {...}), 50)`. */
  countWhere(model: ModelName, where: WhereInput): DbValue;
}

// ---------------------------------------------------------------------------
// 7. Declarations
// ---------------------------------------------------------------------------

/** Options common to every declaration. */
export interface CommonOptions {
  /**
   * One or two sentences of human intent. Recommended everywhere; REQUIRED on exposed actions in
   * declared mode (A2105). Surfaced by `inspect` and in spec cards. Never inferred.
   */
  intent?: string;
  /** Owning team or person, free text. */
  owner?: string;
  tags?: readonly string[];
}

// --- entity ---

/**
 * The entity NAME is the Prisma model name (A1003 checks it); the client accessor is derived as
 * `Uncapitalize(name)` and never declared. Tenant scoping in V0 is an ordinary policy predicate; there
 * is no `tenantKey` option (Stage 2 `tenant` primitive).
 */
export interface EntityOptions extends CommonOptions {
  /**
   * Row invariants. Bare paths refer to the row. Tier 1 only (predicates/guards are rejected by type).
   * Declared mode: evaluated on the reloaded subject and on `result` when `output` is this entity.
   * Observe mode: evaluated on the before/after `findMany` diff of this model in the test database.
   * Also derived into a generated property test.
   */
  invariant?: Readonly<Record<string, ExprClause>>;
}

export interface EntityDecl<Name extends PascalName = PascalName> {
  readonly kind: "entity";
  readonly name: Name;
  readonly options: EntityOptions;
}

// --- policy ---

/** Guard form of a policy: `input` is untyped (policies are shared across actions), `actor` is never null. */
export type PolicyGuardFn = GuardFn<unknown, undefined, Actor>;

export interface PolicyOptions extends CommonOptions {
  /**
   * The authorization rule. Evaluated with `input` (validated) and `actor` only; `self`, `result`
   * and `old` are not available (A3003). A guard here makes the auth matrix non-derivable for the
   * actions it protects (A2106 warning). An anonymous actor never reaches the policy: the pipeline
   * answers 401 first.
   */
  allow: AnalysableClause | PolicyGuardFn;
}

export interface PolicyDecl<Id extends DeclaredId = DeclaredId> {
  readonly kind: "policy";
  readonly id: Id;
  readonly options: PolicyOptions;
}

// --- event ---

export type PayloadShape = Readonly<Record<string, PayloadType>>;

/** TS type of a payload field given its declared PayloadType. */
export type PayloadFieldTs<T extends PayloadType> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "date"
        ? Date
        : unknown;

export type PayloadOf<P extends PayloadShape> = { [K in keyof P]: PayloadFieldTs<P[K]> };

export interface EventOptions<P extends PayloadShape = PayloadShape> extends CommonOptions {
  payload: P;
  /** True when consumers live outside this repo; suppresses A4003 (event without consumer). */
  external?: boolean;
}

export interface EventDecl<Name extends PascalName = PascalName, P extends PayloadShape = PayloadShape> {
  readonly kind: "event";
  readonly name: Name;
  readonly options: EventOptions<P>;
  /** IR id, `Event:<Name>`. */
  readonly id: EventId;
}

// --- action ---

/** Any Zod schema usable as an input schema. */
export type InputSchema = z.ZodType;

/** Output declaration: an entity (by declaration or name), a Zod schema, or "void". Unknown entity names are A1003. */
export type OutputDecl = EntityDecl | PascalName | z.ZodType | "void";

/**
 * The subject row backing `self.*`/`old.*`. `where` MUST identify at most one row: 0 rows makes `self.*`
 * evaluate to `undefined`; > 1 rows is a runtime 412 with contract `Contract:<action>.requires.$subject`
 * (SPEC-DECLARATIONS §5.3). Unknown entity names are A1003.
 */
export interface SubjectSpec {
  entity: EntityDecl | PascalName;
  where: WhereInput;
}

/** Authorization: a policy or an explicit `public: true`; never neither and never both (enforced by type). */
export type WithPolicy = { policy: PolicyDecl; public?: never };
export type WithPublic = { public: true; policy?: never };
export type AuthOptions = WithPolicy | WithPublic;

/**
 * Transaction option in declared mode. `true` (default) wraps the pipeline in `prisma.$transaction`
 * with Prisma's defaults (interactive-transaction `timeout` 5 000 ms, `maxWait` 2 000 ms); an object
 * passes `timeout`/`maxWait` (ms) through to Prisma. `false` runs on the plain client (an `ensures`
 * failure then cannot roll back and the 500 body carries `committed: true`).
 */
export type TransactionOptions = boolean | { timeout?: number; maxWait?: number };

/** `A` is the actor type seen by guards and `run`: `Actor` with a policy, `Actor | null` when public. */
export interface ActionOptionsBase<I extends InputSchema, A extends Actor | null> extends CommonOptions {
  /**
   * HTTP route this action is served at. MUST match an existing Hono/Express registration
   * (A2101); Averr never generates routes in V0. Optional in declared mode (internal actions),
   * required in observe mode.
   */
  route?: RouteSpec;
  /** Zod schema for the request input. The adapter builds the input as `{ ...body|query, ...params }` (path params win). */
  input: I;
  output?: OutputDecl;
  subject?: SubjectSpec;
  /**
   * Preconditions. Evaluated after validation and authorization, inside the transaction when there is
   * one, before `run`. All clauses are evaluated; the first failure determines the response: in declared
   * mode 412 `{ error: "PreconditionFailed", contract }` and `run` is never called.
   * Allowed refs: input, actor, self. Guards here see `result: undefined`.
   */
  requires?: Readonly<Record<string, AnalysableClause | GuardFn<z.output<I>, undefined, A>>>;
  /**
   * Postconditions. Evaluated after `run` returns and before the transaction commits (declared mode)
   * or against response body and DB after-state (observe mode). A violation rolls back and returns
   * 500 `{ error: "PostconditionFailed", contract }` in declared mode. Allowed refs: input, actor,
   * self (after), old (before), result; plus `e.emitted`. Guards here see `result: unknown`.
   */
  ensures?: Readonly<Record<string, AnalysableClause | GuardFn<z.output<I>, unknown, A>>>;
  /** Declared effects; compared with scanned effects (A4002). */
  effects: readonly Effect[];
  /** Idempotency FACT: generates the duplicate-delivery test and suppresses A5002. No runtime dedupe in V0. */
  idempotency?: IdempotencySpec;
}

/**
 * Context passed to `run` in declared mode.
 */
export interface ActionContext<I extends InputSchema = InputSchema, A extends Actor | null = Actor> {
  /** Validated input (`z.output<I>`). */
  input: z.output<I>;
  actor: A;
  /**
   * The project's Prisma client. When `transaction` is not `false` this is the interactive-transaction
   * client passed by `prisma.$transaction(async (tx) => ...)`; subject load, `requires` (tier 1/2), `run`,
   * subject reload and `ensures` all run inside it and an ensures violation rolls it back. Guards always
   * receive the PLAIN client. When `transaction: false` it is the plain client.
   */
  tx: TxClient;
  /** Subject row loaded before run (null when no `subject`). */
  self: Record<string, unknown> | null;
  /**
   * Record an event emission. Emissions are buffered and published only after `ensures` pass and
   * the transaction commits. `e.emitted()` counts buffered emissions.
   */
  emit<E extends EventDecl>(event: E, payload: PayloadOf<E["options"]["payload"]>): void;
}

export interface DeclaredActionOptions<I extends InputSchema, O, A extends Actor | null> extends ActionOptionsBase<I, A> {
  /** The handler. Receives typed ctx; returns the result that `result.*` refers to. Method syntax keeps decls assignable to `AnyActionDecl`. */
  run(ctx: ActionContext<I, A>): Promise<O> | O;
  /** Default true. See {@link TransactionOptions}. */
  transaction?: TransactionOptions;
  handler?: never;
}

/**
 * A reference to an existing framework handler (Hono `(c) => ...` or Express `(req, res, next) => ...`).
 * Averr never calls it: it is used ONLY by `effect-scan`, handler line counting and the A2101 fix.
 * Interception happens at the fetch boundary by route matching (SPEC-DECLARATIONS §6).
 */
export type HandlerRef = (...args: never[]) => unknown;

export interface ObserveActionOptions<I extends InputSchema, A extends Actor | null> extends ActionOptionsBase<I, A> {
  /** Required in observe mode: the adapter matches requests by route. */
  route: RouteSpec;
  /**
   * Observe mode: the existing handler, untouched and optional (most Hono/Express handlers are inline
   * and have no exported symbol). Without it `effect-scan` cannot run and A4002 is downgraded to info.
   * Contracts are evaluated ONLY under Vitest through the observe adapter. Nothing runs in production.
   */
  handler?: HandlerRef;
  run?: never;
  /** Not available in observe mode: Averr does not own the transaction. */
  transaction?: never;
}

export type ActionOptions<I extends InputSchema, O, A extends Actor | null> =
  | DeclaredActionOptions<I, O, A>
  | ObserveActionOptions<I, A>;

export type ActionMode = "declared" | "observe";

export interface ActionDecl<
  Id extends DeclaredId = DeclaredId,
  I extends InputSchema = InputSchema,
  O = unknown,
  M extends ActionMode = ActionMode,
  A extends Actor | null = Actor | null,
> {
  readonly kind: "action";
  readonly id: Id;
  /** `run` present → "declared"; otherwise "observe". */
  readonly mode: M;
  readonly options: ActionOptions<I, O, A> & AuthOptions;
  /** Phantom types for consumers (never set at runtime). */
  readonly __types?: { input: z.output<I>; output: O; actor: A };
}

/** Any action declaration. `any` is deliberate: `I`, `O` and `A` occur in contravariant positions (`run`, guards). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDecl = ActionDecl<DeclaredId, any, any, ActionMode, any>;

// --- query ---

export interface QueryContext<I extends InputSchema = InputSchema, A extends Actor | null = Actor> {
  input: z.output<I>;
  actor: A;
  /** Non-transactional client. Writes are a compile error when detected (A4004). */
  db: PrismaClientLike;
}

export interface QueryOptionsBase<I extends InputSchema> extends CommonOptions {
  route?: RouteSpec;
  input: I;
  output?: OutputDecl;
}

export interface DeclaredQueryOptions<I extends InputSchema, O, A extends Actor | null> extends QueryOptionsBase<I> {
  run(ctx: QueryContext<I, A>): Promise<O> | O;
  handler?: never;
}

export interface ObserveQueryOptions<I extends InputSchema> extends QueryOptionsBase<I> {
  route: RouteSpec;
  handler?: HandlerRef;
  run?: never;
}

/** Queries carry a policy (or public) and nothing else: no requires, no ensures, no effects. */
export type QueryOptions<I extends InputSchema, O, A extends Actor | null> = DeclaredQueryOptions<I, O, A> | ObserveQueryOptions<I>;

export interface QueryDecl<
  Id extends DeclaredId = DeclaredId,
  I extends InputSchema = InputSchema,
  O = unknown,
  M extends ActionMode = ActionMode,
  A extends Actor | null = Actor | null,
> {
  readonly kind: "query";
  readonly id: Id;
  readonly mode: M;
  readonly options: QueryOptions<I, O, A> & AuthOptions;
  readonly __types?: { input: z.output<I>; output: O; actor: A };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyQueryDecl = QueryDecl<DeclaredId, any, any, ActionMode, any>;

// --- workflow ---

export interface WorkflowOptions extends CommonOptions {
  /** The event that starts this workflow. Adds `Event -consumedBy-> Workflow`. */
  on: EventDecl;
  /**
   * The runner object from the project's durable-execution library (an Inngest function, a pg-boss
   * handler registration, ...). Averr never executes it; the compiler resolves the identifier to a
   * SymbolRef and scans the referenced source for `step.run("name", ...)`.
   */
  runner: object;
  /** Default: inferred from the runner's import (`inngest` | `pg-boss`), else "custom". */
  engine?: WorkflowEngine;
  retry?: RetrySpec;
}

export interface WorkflowDecl<Name extends PascalName = PascalName> {
  readonly kind: "workflow";
  readonly name: Name;
  readonly options: WorkflowOptions;
}

// --- integration ---

export interface WebhookOptions {
  /** Header carrying the signature, e.g. `"stripe-signature"`. */
  verify: string;
  /** Signing scheme the generated tests use. `custom` yields only the tampered-body rejection test. */
  scheme: WebhookScheme;
  /** Environment variable holding the signing secret for tests (e.g. `"STRIPE_WEBHOOK_SECRET"`). Required unless `scheme: "custom"`. */
  secretEnv?: string;
  /** True when verification needs the unparsed body. Generates the `pitfall.raw-body` test and A5001. */
  rawBody: boolean;
  /** The receiving route, if known; otherwise matched by scanning for the verify header. */
  route?: RouteSpec;
}

export interface IntegrationOptions extends CommonOptions {
  /** The foreign client object (e.g. `new Stripe(...)`). Resolved to a SymbolRef; used for import/call scanning only. */
  client?: object;
  webhook?: WebhookOptions;
  idempotency?: IdempotencySpec;
  /** True when calls MUST NOT happen inside a Averr-owned transaction (A4005). Default true. */
  nonTransactional?: boolean;
  /** Default `["network"]`. */
  effects?: readonly Effect[];
}

export interface IntegrationDecl<Name extends PascalName = PascalName> {
  readonly kind: "integration";
  readonly name: Name;
  readonly options: IntegrationOptions;
}

export type Declaration = EntityDecl | PolicyDecl | EventDecl | AnyActionDecl | AnyQueryDecl | WorkflowDecl | IntegrationDecl;

// ---------------------------------------------------------------------------
// 8. The API as a single interface (what index.ts must implement)
// ---------------------------------------------------------------------------

export interface DeclarationApi {
  /** Attach facts to an existing Prisma model. No schema changes. `name` MUST be the model name. */
  entity<N extends PascalName>(name: N, options?: EntityOptions): EntityDecl<N>;
  /** Declare a reusable authorization rule. */
  policy<Id extends DeclaredId>(id: Id, options: PolicyOptions): PolicyDecl<Id>;
  /** Declare a named event with a flat payload. */
  event<N extends PascalName, P extends PayloadShape>(name: N, options: EventOptions<P>): EventDecl<N, P>;
  /** Declared mode with a policy: `actor` is non-null in `run` and guards. */
  action<Id extends DeclaredId, I extends InputSchema, O>(
    id: Id,
    options: DeclaredActionOptions<I, O, Actor> & WithPolicy,
  ): ActionDecl<Id, I, O, "declared", Actor>;
  /** Declared mode, public: `actor` may be null. */
  action<Id extends DeclaredId, I extends InputSchema, O>(
    id: Id,
    options: DeclaredActionOptions<I, O, Actor | null> & WithPublic,
  ): ActionDecl<Id, I, O, "declared", Actor | null>;
  /** Observe mode with a policy (existing handler, test-time contracts). */
  action<Id extends DeclaredId, I extends InputSchema>(
    id: Id,
    options: ObserveActionOptions<I, Actor> & WithPolicy,
  ): ActionDecl<Id, I, unknown, "observe", Actor>;
  /** Observe mode, public. */
  action<Id extends DeclaredId, I extends InputSchema>(
    id: Id,
    options: ObserveActionOptions<I, Actor | null> & WithPublic,
  ): ActionDecl<Id, I, unknown, "observe", Actor | null>;
  /** Declare a read with a policy and no contracts. */
  query<Id extends DeclaredId, I extends InputSchema, O>(
    id: Id,
    options: DeclaredQueryOptions<I, O, Actor> & WithPolicy,
  ): QueryDecl<Id, I, O, "declared", Actor>;
  query<Id extends DeclaredId, I extends InputSchema, O>(
    id: Id,
    options: DeclaredQueryOptions<I, O, Actor | null> & WithPublic,
  ): QueryDecl<Id, I, O, "declared", Actor | null>;
  query<Id extends DeclaredId, I extends InputSchema>(
    id: Id,
    options: ObserveQueryOptions<I> & WithPolicy,
  ): QueryDecl<Id, I, unknown, "observe", Actor>;
  query<Id extends DeclaredId, I extends InputSchema>(
    id: Id,
    options: ObserveQueryOptions<I> & WithPublic,
  ): QueryDecl<Id, I, unknown, "observe", Actor | null>;
  /** Bind an event consumer implemented by an external durable-execution runner. */
  workflow<N extends PascalName>(name: N, options: WorkflowOptions): WorkflowDecl<N>;
  /** Declare a foreign API client and its pitfall facts. */
  integration<N extends PascalName>(name: N, options: IntegrationOptions): IntegrationDecl<N>;
  e: ExpressionBuilder;
  db: DbPredicateBuilder;
}

// ---------------------------------------------------------------------------
// 9. Project configuration (`averr.config.ts`)
// ---------------------------------------------------------------------------

/**
 * One actor fixture for generated tests and the observe adapter. `headers` are sent with every request
 * made as this fixture (the app's own auth middleware turns them into the actor); `actor` is what Averr
 * uses to evaluate policies and `actor.*` refs. The fixture named `anonymous` MUST exist with `actor: null`.
 * Fixture names are project-defined; the reference app uses `anonymous`, `member`, `otherTeamAdmin`, `admin`.
 */
export interface ActorFixture {
  actor: Actor | null;
  headers?: Record<string, string>;
}

export interface EmitterConfig {
  /** Declared mode: bridge from `ctx.emit` to the project's bus/queue, called after commit with `eventNamePrefix + name`. */
  publish(name: string, payload: Record<string, unknown>): void | Promise<void>;
  /** Observe mode: the method on the project's emitter client to spy on (`{ target: inngest, method: "send" }`). */
  spy: { target: object; method: string };
  /** Prefix of the project's event names, e.g. `"averr/"`. Used by `publish`, by the spy and by `consumer-scan` (statically). */
  eventNamePrefix: string;
}

/**
 * Resolved configuration. `averr.config.ts` default-exports `defineConfig({...})`. The compiler lowers
 * the STATIC fields it needs (`sourceRoots`, `prismaSchema`, `prismaClient`, `entryPoints`, `publicMarker`,
 * `authMiddleware`, `emitter.eventNamePrefix`, fixture names, `test`) with ts-morph under the same
 * analysable-subset rule as declarations (A1004); it never imports the file. `@averr/contracts` imports
 * it at test time (observe adapter) and at runtime (declared mode) for the function-valued fields.
 */
export interface AverrConfig {
  /** Directories scanned for TypeScript. Default `["src"]`. */
  sourceRoots: string[];
  /** Default `"prisma/schema.prisma"`. */
  prismaSchema: string;
  /** Fallback for `effect-scan` client recognition when the TypeChecker type is not `PrismaClient`. Default null. */
  prismaClient: { file: string; symbol: string } | null;
  /** Files that build the Hono app / Express app (`src/app.ts`). Required for route extraction and the observe adapter. */
  entryPoints: string[];
  /** Actor fixtures; `anonymous` is mandatory. */
  actors: Record<string, ActorFixture> & { anonymous: { actor: null; headers?: Record<string, string> } };
  /** Null when the project emits no events. */
  emitter: EmitterConfig | null;
  /** Middleware identifier the extractor treats as "intentionally public" (`publicRoute()`); never guessed. Default null. */
  publicMarker: string | null;
  /** Middleware identifiers that establish `actor` (`auth`, `requireUser`). Used by A2103 for undeclared exposures. Default `[]`. */
  authMiddleware: string[];
  /** Production sampling in declared mode, 0..1. `requires` and `allow` are always on. Default `{ ensures: 0, invariants: 0 }`. */
  sampling: { ensures: number; invariants: number };
  test: {
    /** Env var with the TEST database URL the project supplies. Default `"DATABASE_URL"`. No pglite in V0. */
    databaseUrlEnv: string;
    /** Where generated tests are written. Default `"tests/averr"`. */
    generatedDir: string;
  };
}

/** What the user writes; everything with a documented default is optional. */
export interface AverrConfigInput {
  sourceRoots?: string[];
  prismaSchema?: string;
  prismaClient?: { file: string; symbol: string };
  entryPoints: string[];
  actors: AverrConfig["actors"];
  emitter?: EmitterConfig;
  publicMarker?: string;
  authMiddleware?: string[];
  sampling?: Partial<AverrConfig["sampling"]>;
  test?: Partial<AverrConfig["test"]>;
}

/** Fills defaults and freezes. Exported from `@averr/core`. */
export type DefineConfig = (input: AverrConfigInput) => AverrConfig;

// ---------------------------------------------------------------------------
// 10. Runtime-facing shapes shared by @averr/contracts, @averr/testgen and @averr/mcp
// ---------------------------------------------------------------------------

/**
 * Pipeline phases in declared mode, in order. Observe mode records every phase as well; `authorize` is
 * then `observed: true` (the app's own 401/403 is the decision) and `run` is the untouched handler.
 */
export const PHASES = ["validate", "authorize", "requires", "run", "ensures", "emit"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * HTTP status and error code per failing phase in declared mode. Generated tests assert these.
 * `emit` is TRACE-ONLY: the transaction has committed, so the client receives the 2xx result and the
 * failure is recorded in the trace (and fails the test under Vitest); a 500 would trigger client retries
 * of committed work.
 */
export const PHASE_FAILURE = {
  validate: { status: 400, error: "ValidationFailed" },
  authorize: { status: 403, error: "Forbidden" },
  requires: { status: 412, error: "PreconditionFailed" },
  run: { status: 500, error: "HandlerError" },
  ensures: { status: 500, error: "PostconditionFailed" },
  emit: { status: null, error: "EmitFailed" },
} as const satisfies Record<Phase, { status: number | null; error: string }>;

/** `authorize` with `actor === null` on a non-public declaration short-circuits to this before the policy runs. */
export const AUTHENTICATION_FAILURE = { status: 401, error: "Unauthenticated" } as const;

/** Declared-mode success status (adapters may override per route). */
export const SUCCESS_STATUS = 200 as const;

/** Error body returned by declared-mode actions and asserted by generated tests. */
export interface ContractViolationBody {
  error: (typeof PHASE_FAILURE)[Phase]["error"] | (typeof AUTHENTICATION_FAILURE)["error"];
  /** `Contract:...` id for requires/ensures (incl. `...requires.$subject`), `Policy:...` id for authorize, absent otherwise. */
  contract?: string;
  /** Evaluated operands keyed by AST path (see PhaseRecord); absent for guards. */
  evaluated?: Record<string, { lhs: unknown; rhs: unknown }>;
  /** Present on `PostconditionFailed` when `transaction: false`: the write could not be rolled back. */
  committed?: boolean;
  message: string;
}

/**
 * One recorded trace per action invocation (test and dev). Appended as one JSON line to
 * `.averr/traces/<YYYY-MM-DD>.<pid>.jsonl` (one file per process because Vitest workers append concurrently).
 */
export interface ActionTrace {
  traceId: string;
  action: `Action:${string}` | `Query:${string}`;
  mode: ActionMode;
  startedAt: string;
  durationMs: number;
  /** `summary` is `<role ?? "">#<id>` truncated to 40 chars; no PII beyond id and role. */
  actor: { id: string; summary: string } | null;
  phases: PhaseRecord[];
  outcome:
    | { ok: true }
    | {
        ok: false;
        phase: Phase;
        contract?: string;
        message: string;
        /** True when the failure happened after commit (`emit`) or without a transaction. */
        committed: boolean;
      };
  /** Pasteable reproduction: method, path, body, headers (secrets redacted). */
  request?: { method: HttpMethod; path: string; body: unknown; headers: Record<string, string> };
  /** Set under Vitest from `expect.getState()`: joins the trace to a Test node and to the `check` output. */
  test?: { file: string; title: string };
}

/**
 * `evaluated` is keyed by the AST path of the comparison node: `""` for a root comparison, `args[1]`
 * for the second conjunct, `arg.args[0]` under a `not`. For `and` it holds the first failing leaf; for
 * `or` every leaf. `undefinedRefs` lists refs that resolved to `undefined` (fail-closed rule).
 */
export type PhaseRecord =
  | { phase: "validate"; ok: boolean; issues?: unknown[] }
  | {
      phase: "authorize";
      ok: boolean;
      policy: string | null;
      decision: "allow" | "deny" | "public" | "unauthenticated";
      /** True in observe mode: the decision is the app's own 401/403, not a Averr evaluation. */
      observed: boolean;
    }
  | {
      phase: "requires" | "ensures";
      ok: boolean;
      contract: string;
      tier: "expr" | "predicate" | "guard";
      evaluated?: Record<string, { lhs: unknown; rhs: unknown }>;
      undefinedRefs?: RefPath[];
      durationMs: number;
    }
  | { phase: "run"; ok: boolean; durationMs: number; dbCalls: number; error?: string }
  | { phase: "emit"; ok: boolean; events: Array<{ event: EventId; payloadHash: string }>; error?: string };

// --- declared-mode adapters (implemented by @averr/contracts) ---

/** Actor type of a declaration (`Actor` or `Actor | null`). */
export type ActorOf<D> = D extends { readonly __types?: { actor: infer A } } ? A : never;

export interface HandleResult {
  status: number;
  /** The serialised result (Date → ISO string, Decimal/BigInt → string, `undefined` dropped) or a ContractViolationBody. */
  body: unknown;
  trace: ActionTrace;
}

/**
 * Options of `toHono`/`toExpress`. `Req` is the framework's request/context type (Hono `Context`,
 * Express `Request`); core does not depend on either framework.
 */
export interface AdapterOptions<Req, A extends Actor | null> {
  /** Extract the actor from the request. Return `null` for anonymous. */
  actor(req: Req): A | Promise<A>;
  /** Override input extraction. Default: `{ ...(GET ? query : body), ...params }` — path params win on key clash. */
  input?(req: Req): unknown | Promise<unknown>;
  /** Success status. Default {@link SUCCESS_STATUS}. */
  status?: number;
}

export interface DeclaredRuntime {
  /** Framework-neutral pipeline for one declaration. */
  handle<D extends AnyActionDecl | AnyQueryDecl>(decl: D): (input: unknown, actor: ActorOf<D>) => Promise<HandleResult>;
  /** Hono handler. The A2101 fix recognises `toHono(<Decl>, ...)` as the Exposure's handler. */
  toHono<D extends AnyActionDecl | AnyQueryDecl, C>(decl: D, options: AdapterOptions<C, ActorOf<D>>): (c: C) => Promise<Response>;
  /** Express handler. */
  toExpress<D extends AnyActionDecl | AnyQueryDecl, Req, Res>(
    decl: D,
    options: AdapterOptions<Req, ActorOf<D>>,
  ): (req: Req, res: Res, next: (err?: unknown) => void) => Promise<void>;
}

// --- observe mode (Vitest only; implemented by @averr/contracts) ---

/** A Hono app (anything with `fetch(Request)`). */
export type FetchApp = { fetch(request: Request, ...rest: never[]): Response | Promise<Response> };
/** An Express app (a Node request listener). It is served on an ephemeral port for the duration of the test file. */
export type ListenerApp = (req: never, res: never) => void;

export interface ObserveOptions {
  declarations: readonly Declaration[];
  config: AverrConfig;
}

export interface ObserveRequest {
  method: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ObserveResponse {
  status: number;
  body: unknown;
  /** Null when the request matched no declared route. */
  trace: ActionTrace | null;
}

export interface ObserveHandle {
  /** Send one request as the named actor fixture; the matching declaration's contracts are evaluated around the real handler. */
  request(actorFixture: string, req: ObserveRequest): Promise<ObserveResponse>;
  close(): Promise<void>;
}

export interface ObserveApi {
  observe(app: FetchApp | ListenerApp, options: ObserveOptions): Promise<ObserveHandle>;
}

/** Re-exported AST building blocks so consumers can type the `ast` fields without importing @averr/ir directly. */
export type { BoolExpr, Operand, Ref, DbWhere };
