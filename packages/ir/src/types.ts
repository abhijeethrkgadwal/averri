/**
 * @averr/ir — the Semantic IR.
 *
 * This file is the normative TypeScript form of docs/SPEC-IR.md, SPEC-CONTRACTS.md
 * (AST section) and SPEC-DIAGNOSTICS.md. Every other package consumes these types;
 * none may extend them ad hoc. Changes here are spec changes and must update the
 * Markdown specs in the same commit. Decisions that deviate from the FINAL design
 * document or from review findings are logged in docs/SPEC-DECISIONS.md.
 *
 * Conventions:
 * - All ids are strings of the form `<Kind>:<qualifier>` (see {@link NodeId}).
 * - All file paths are repo-relative, POSIX separators, no leading "./".
 * - Lines are 1-based, columns are 0-based (see {@link Position}). ts-morph's
 *   `getLineAndColumnAtPos` returns BOTH 1-based; every extractor subtracts 1 from the column.
 * - The graph is a pure function of (repository content, averr version). It is a cache,
 *   never committed, never hand-edited.
 * - "Schema facts" means what `@averr/extract` derives from `schema.prisma` with
 *   `@mrleebo/prisma-ast` (models, fields, types, `?`, `[]`, `@id`/`@@id`, `@unique`/`@@unique`,
 *   `@default`, `@relation(fields, references)`, enums, `Unsupported`). Averr does not use
 *   Prisma's DMMF or `@prisma/internals`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. Identity
// ---------------------------------------------------------------------------

/**
 * Node kinds in V0. Closed set; adding a kind is a spec change.
 *
 * - Entity:      a persisted domain object (one per Prisma model, optionally enriched via entity()).
 * - Field:       a scalar/enum/relation field of an Entity (extracted from the Prisma schema facts).
 * - Action:      a state-changing operation (declared via action()).
 * - Query:       a declared read (policy only, no requires/ensures).
 * - Policy:      an authorization rule evaluated against actor and input.
 * - Contract:    one clause: requires | ensures | invariant | allow. Owned by an Action, Entity or Policy.
 * - Event:       a named payload emitted by Actions/Workflows and consumed by Workflows/Integrations.
 * - Workflow:    a consumer bound to an external durable-execution runner (Inngest, pg-boss, custom).
 * - Integration: a foreign API client with encoded pitfalls (webhook verification, raw body, idempotency).
 * - Exposure:    an HTTP route registration found in Hono/Express source (extracted), optionally bound to an Action/Query.
 * - Test:        a Vitest test (generated or hand-written) that verifies one or more nodes.
 * - Module:      a source file (declaration module, route file, handler, Prisma schema, test file).
 */
export const NODE_KINDS = [
  "Entity",
  "Field",
  "Action",
  "Query",
  "Policy",
  "Contract",
  "Event",
  "Workflow",
  "Integration",
  "Exposure",
  "Test",
  "Module",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Stable string id. Format: `<Kind>:<qualifier>`; the qualifier grammar depends on the kind:
 *
 * | Kind        | Qualifier                                    | Example                                             |
 * |-------------|----------------------------------------------|-----------------------------------------------------|
 * | Entity      | PascalCase entity name (= Prisma model name) | `Entity:Invitation`                                 |
 * | Field       | `<Entity>.<field>`                           | `Field:Invitation.status`                           |
 * | Action      | the declared id string, `<Scope>.<verb>`     | `Action:Team.inviteMember`                          |
 * | Query       | the declared id string                       | `Query:Team.listMembers`                            |
 * | Policy      | the declared id string                       | `Policy:Team.OwnerOrAdmin`                          |
 * | Contract    | `<ownerQualifier>.<phase>.<clauseName>`      | `Contract:Team.inviteMember.requires.notAlreadyMember`, `Contract:Invitation.invariant.pendingHasNoAcceptedAt`, `Contract:Team.OwnerOrAdmin.allow` (policies: phase only, no clause name) |
 * | Event       | the declared event name                      | `Event:MemberInvited`                               |
 * | Workflow    | the declared workflow name                   | `Workflow:InviteFlow`                               |
 * | Integration | the declared integration name                | `Integration:Stripe`                                |
 * | Exposure    | `<router>:<file>:<line>:<col>` of the method identifier of the registration (`.post` in `app.post(...)`); col is 0-based | `Exposure:hono:src/routes/teams.ts:41:4`            |
 * | Test        | `gen/<ownerQualifier>.<suite>` for generated; `<file>:<line>` for hand-written | `Test:gen/Team.inviteMember.auth-matrix`, `Test:tests/members.test.ts:17` |
 * | Module      | repo-relative file path                      | `Module:src/members/inviteMember.ts`                |
 *
 * Ids are durable: the string in the declaration call IS the identity. There are no ULIDs.
 * Duplicate ids are a compile error (A1001). A disappearing id whose `run`/`handler` reference
 * reappears under a new id is reported as a rename (A1002).
 *
 * Clause names starting with `$` are reserved for synthetic contracts the runtime reports
 * (`Contract:<action>.requires.$subject` for an ambiguous subject). Declared clause names
 * MUST NOT start with `$` (A1004).
 *
 * Ids are not file-safe (`:` is illegal on Windows, `/` creates directories). Every id-derived
 * path under `.averr/` uses `encodeURIComponent(id)` (helper `nodeIdToFileName` in @averr/ir).
 */
export type NodeId = `${NodeKind}:${string}`;

/** Narrowed id helpers used by node payloads for readability. They are all plain strings at runtime. */
export type EntityId = `Entity:${string}`;
export type FieldId = `Field:${string}`;
export type ActionId = `Action:${string}`;
export type QueryId = `Query:${string}`;
export type PolicyId = `Policy:${string}`;
export type ContractId = `Contract:${string}`;
export type EventId = `Event:${string}`;
export type WorkflowId = `Workflow:${string}`;
export type IntegrationId = `Integration:${string}`;
export type ExposureId = `Exposure:${string}`;
export type TestId = `Test:${string}`;
export type ModuleId = `Module:${string}`;

/**
 * Diagnostic ids are per-build sequence numbers: `D-0001`, `D-0002`, ... They are not stable across
 * builds. `check` persists its diagnostics in `.averr/last-check.json` so `explain {diagId}` can
 * resolve them until the next build changes the content hash (SPEC-MCP §6.6).
 */
export type DiagnosticId = `D-${string}`;

// ---------------------------------------------------------------------------
// 2. Source locations and provenance
// ---------------------------------------------------------------------------

/** `[line, column]`; line is 1-based (matches editors and `path:line` strings), column is 0-based. */
export type Position = [line: number, column: number];

/** A span in one file. `range` is `[start, end]`, end exclusive. */
export interface SourceRange {
  /** Repo-relative POSIX path. */
  file: string;
  range: [start: Position, end: Position];
}

/** A reference to an exported or local symbol in a file, used for Zod schemas, handlers, runners, clients. */
export interface SymbolRef {
  file: string;
  /** Dotted member path, e.g. `InviteMember.input`, `listRoutes.inviteMember`, `default`. */
  symbol: string;
  range?: SourceRange;
}

/**
 * Provenance level of a node or edge.
 * - extracted: produced by a heuristic extractor from code or schema. MUST carry evidence and a confidence.
 * - declared:  written by a human or agent through the @averr/core declaration API.
 * - verified:  a declaration that EVERY applicable static verifier confirmed against handler/route/schema code
 *              (e.g. a declared `writes` matched a `tx.invitation.*` call in `run`). See {@link VerifierId}.
 */
export type Origin = "extracted" | "declared" | "verified";

/** Evidence categories. `note` is a one-line human-readable justification; never a confidence float. */
export type EvidenceKind =
  | "source" // a source span was read and matched a pattern
  | "call" // a call expression (e.g. tx.invitation.upsert) was found
  | "import" // an import statement binds the symbol
  | "schema" // the Prisma schema facts or a Zod schema state it
  | "route" // a router registration states it
  | "test" // a test asserts it
  | "trace"; // a recorded runtime trace observed it

export interface Evidence {
  kind: EvidenceKind;
  note: string;
  src?: SourceRange;
}

/** Identifier of the extractor that produced an extracted node (used in evidence and health counters). */
export type ExtractorId = "prisma" | "hono" | "express" | "zod" | "ts-handler" | "vitest";

/**
 * Identifier of a verifier that confirms a declared node/edge.
 *
 * A node is `verified` iff every verifier APPLICABLE to it passed:
 * - `route-match`   applicable when the declaration has `route`;
 * - `effect-scan`   applicable to every Action/Query that has a resolvable `run`/`handler` body;
 * - `emit-scan`     applicable when `event:emit` is declared or an `emitted` clause exists;
 * - `zod-match`     applicable when `input` resolves to a Zod schema;
 * - `consumer-scan` applicable to Events with `external: false`;
 * - `test-link`     applicable to hand-written Test nodes.
 * When any applicable verifier fails the node stays `declared` and the per-field results
 * (`route.verified`, `effects.verified`) say which one failed.
 */
export type VerifierId = "effect-scan" | "route-match" | "zod-match" | "emit-scan" | "consumer-scan" | "test-link";

export type Provenance =
  | {
      origin: "extracted";
      extractor: ExtractorId;
      /** 0..1. Extractors MUST document how it is computed. Tools MUST refuse to assert facts below 0.9 (see SPEC-MCP). */
      confidence: number;
      evidence: Evidence[];
    }
  | {
      origin: "declared";
      /** The declaration call site. */
      declaredAt: SourceRange;
    }
  | {
      origin: "verified";
      declaredAt: SourceRange;
      /** Every applicable verifier, all of which passed. Non-empty. */
      verifiers: VerifierId[];
      evidence: Evidence[];
    };

// ---------------------------------------------------------------------------
// 3. Contract expression AST (serializable; the only form stored in the IR)
// ---------------------------------------------------------------------------

/**
 * Contract tiers. The tier is a property of a whole clause, derived from its AST:
 * - "guard"     if the clause is an opaque async function; it has no AST.
 * - "predicate" if the AST contains at least one `db.*` node.
 * - "expr"      otherwise.
 * See SPEC-CONTRACTS.md for the derivation rule and what each tier enables.
 */
export type ContractTier = "expr" | "predicate" | "guard";

/** Which clause of a declaration the contract belongs to. */
export type ContractPhase = "requires" | "ensures" | "invariant" | "allow";

/**
 * Reference roots. A ref path is `<root>.<field>(.<field>)*` with at most 3 segments after the root.
 * - input.*   validated action/query input (Zod output type)
 * - result.*  the value returned by run/handler (ensures only)
 * - actor.*   the authenticated principal (shape is project-defined via the Actor type)
 * - self.*    the subject entity row (requires: before run; ensures and invariant: after run)
 * - old.*     the subject entity row as it was before run (ensures only). Spelled old(self).x in prose.
 */
export type RefRoot = "input" | "result" | "actor" | "self" | "old";
export const REF_ROOTS = ["input", "result", "actor", "self", "old"] as const satisfies readonly RefRoot[];

export type RefPath = `${RefRoot}.${string}`;

/** A reference operand. */
export interface Ref {
  ref: RefPath;
}

/** Literal scalar or list of scalars. Lists are only valid as the rhs of `in`. */
export type LitScalar = string | number | boolean | null;
export interface Lit {
  lit: LitScalar | LitScalar[];
}

/** Length of a string or owned list reachable by a ref path. */
export interface LenExpr {
  op: "len";
  arg: Ref;
}
/** Sum of `field` over the elements of an owned list. */
export interface SumExpr {
  op: "sum";
  /** Path to an owned list, e.g. `self.lines`. */
  path: Ref;
  /** Field of each element to sum, e.g. `amount`. */
  field: string;
}
/** Number of elements of an owned list, optionally filtered. Inside `where`, `self.*` refers to the element. */
export interface CountExpr {
  op: "count";
  path: Ref;
  where?: BoolExpr;
}

/** DB predicate that yields a number (makes the clause tier "predicate"). */
export interface DbCountWhere {
  op: "db.countWhere";
  model: string;
  where: DbWhere;
}

/** Anything that evaluates to a value and can appear on either side of a comparison. */
export type Operand = Ref | Lit | LenExpr | SumExpr | CountExpr | DbCountWhere;

export type CompareOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export interface CompareExpr {
  op: CompareOp;
  lhs: Operand;
  rhs: Operand;
}
/** `args` is non-empty (the builder type enforces it; the schema enforces `.min(1)`). */
export interface AndExpr {
  op: "and";
  args: BoolExpr[];
}
export interface OrExpr {
  op: "or";
  args: BoolExpr[];
}
export interface NotExpr {
  op: "not";
  arg: BoolExpr;
}
export interface InExpr {
  op: "in";
  lhs: Operand;
  /** A literal list or a ref to a list field. */
  rhs: Lit | Ref;
}
export interface IsNullExpr {
  op: "isNull";
  arg: Ref;
}
/** True if at least one element of the owned list satisfies `where` (or the list is non-empty when `where` is absent). */
export interface ExistsExpr {
  op: "exists";
  path: Ref;
  where?: BoolExpr;
}
/**
 * True if the Event was emitted by this invocation the given number of times.
 * A number means exactly that many; absent means `{ min: 1 }`. Valid in `ensures` only (A3003 elsewhere).
 */
export interface EmittedExpr {
  op: "emitted";
  event: EventId;
  count?: number | { min?: number; max?: number };
}

/**
 * Operands allowed inside a `where` operator form. They are evaluated to scalars BEFORE the Prisma
 * call, so only refs, literals and `len` are allowed; `sum`, `count` and nested `db.*` are A3009.
 */
export type DbWhereOperand = Ref | Lit | LenExpr;

/**
 * Literal where-clause over a Prisma model in CANONICAL FLAT FORM: keys are dotted field paths
 * through to-one relations (depth <= 3), e.g. `"user.email"`. This is the only representation:
 * the `db.*` builder in @averr/core flattens nested source objects, so the runtime value, the IR and
 * the test generator all see the same shape. `@averr/contracts` un-flattens into Prisma's nested
 * `where` while substituting refs.
 *
 * Relation rules: a dotted key may traverse only to-one relations. A segment that crosses a
 * `list: true` relation is A3009 (no `some/every/none` quantifier in V0). A Prisma field literally
 * named `in`, `not`, `lt`, `lte`, `gt` or `gte` cannot be addressed (same limitation as Prisma's own
 * filter syntax) and is rejected as A3002.
 *
 * Undefined-ref rule (fail closed): if any ref in `where` evaluates to `undefined`, the whole
 * predicate is false (`db.exists`, `db.unique`, `db.none`) or 0 (`db.countWhere`) and the
 * PhaseRecord lists the refs in `undefinedRefs`. Prisma would otherwise drop the filter.
 */
export type DbWhereValue =
  | Ref
  | Lit
  | { in: Lit | Ref }
  | { not: Ref | Lit }
  | { lt: DbWhereOperand }
  | { lte: DbWhereOperand }
  | { gt: DbWhereOperand }
  | { gte: DbWhereOperand };
export type DbWhere = Record<string, DbWhereValue>;

/** At least one row of `model` matches `where`. */
export interface DbExists {
  op: "db.exists";
  model: string;
  where: DbWhere;
}
/** No row of `model` matches `where`. */
export interface DbNone {
  op: "db.none";
  model: string;
  where: DbWhere;
}
/** Exactly one row of `model` matches `where`. */
export interface DbUnique {
  op: "db.unique";
  model: string;
  where: DbWhere;
}
export type DbPredicate = DbExists | DbNone | DbUnique;

/** Boolean-valued expression. A clause's root is always a BoolExpr (guards excepted). */
export type BoolExpr =
  | CompareExpr
  | AndExpr
  | OrExpr
  | NotExpr
  | InExpr
  | IsNullExpr
  | ExistsExpr
  | EmittedExpr
  | DbPredicate;

/** Every AST node type, for visitors. */
export type ContractExpr = BoolExpr | Operand;

/** Union of all `op` strings. */
export type ContractOp = Extract<ContractExpr, { op: string }>["op"];

// ---------------------------------------------------------------------------
// 4. Shared payload fragments
// ---------------------------------------------------------------------------

/** Declared effects. Closed literal union so tsc rejects hallucinated values. */
export const EFFECTS = ["db:read", "db:write", "event:emit", "network"] as const;
export type Effect = (typeof EFFECTS)[number];

/**
 * Methods a route can be declared with. `app.all(...)` expands to all five; `app.on([..], ...)` expands
 * per listed method; HEAD and OPTIONS registrations are not extracted (no Exposure node).
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const ROUTERS = ["hono", "express"] as const;
export type Router = (typeof ROUTERS)[number];

export interface RouteSpec {
  method: HttpMethod;
  /** Path template as registered, e.g. `/teams/:teamId/invitations`. */
  path: string;
}

/** Route binding on an Action/Query: declared route plus the Exposure it was matched to (if any). */
export interface RouteBinding extends RouteSpec {
  exposure: ExposureId | null;
  /** True when an Exposure with the same method and normalised path was found (verifier "route-match"). */
  verified: boolean;
}

/**
 * Input description: the Zod schema symbol and its top-level field names. Field names and types are
 * derived STATICALLY by the compiler from the TypeChecker type of `z.output<typeof schema>` (works
 * through `.extend/.merge` and imported schemas); the schema is never evaluated.
 */
export interface InputSpec {
  zod: SymbolRef | null;
  fields: string[];
}

/** Output description: an Entity, a Zod schema, or void. */
export type OutputSpec = { entity: EntityId } | { zod: SymbolRef } | { kind: "void" } | { kind: "unknown" };

/**
 * Effects as declared and as verified by `effect-scan` (SPEC-IR §3.1). Mismatches raise A4002.
 * `complete: false` means the scan hit an unresolvable callee (depth > 3, dynamic access, external
 * function receiving the client); A4002 then only ADDS missing effects and never removes declared ones.
 */
export interface EffectsSpec {
  declared: Effect[];
  verified: {
    reads: EntityId[];
    writes: EntityId[];
    emits: EventId[];
    calls: IntegrationId[];
    complete: boolean;
  };
}

/** How the handler is attached. See SPEC-DECLARATIONS.md. */
export type ActionMode = "declared" | "observe";

/**
 * Idempotency FACT. In V0 it produces the generated duplicate-delivery test (`pitfall.idempotency`)
 * and suppresses A5002; there is NO runtime dedupe, replay or storage in V0 (Stage 2; see
 * docs/SPEC-DECISIONS.md D-11).
 */
export interface IdempotencySpec {
  /** Header or input field that carries the key. */
  key: { header: string } | { input: string };
  /** Seconds the key is remembered (recorded as a fact; used by the generated test's second delivery). */
  ttlSeconds: number;
}

export interface RetrySpec {
  attempts: number;
  backoff?: "fixed" | "exponential";
}

/** Payload field types allowed in event() declarations. */
export const PAYLOAD_TYPES = ["string", "number", "boolean", "date", "json"] as const;
export type PayloadType = (typeof PAYLOAD_TYPES)[number];

export type WorkflowEngine = "inngest" | "pg-boss" | "custom";

/** Signature schemes the webhook pitfall tests know how to sign. `custom` yields only the tampered-body test. */
export const WEBHOOK_SCHEMES = ["stripe", "hmac-sha256", "custom"] as const;
export type WebhookScheme = (typeof WEBHOOK_SCHEMES)[number];

export type PrismaScalar = "String" | "Int" | "BigInt" | "Float" | "Decimal" | "Boolean" | "DateTime" | "Json" | "Bytes";

/** `list` is Prisma's `[]` modifier (Postgres scalar lists exist). `unsupported` is Prisma's `Unsupported("...")`. */
export type FieldType =
  | { kind: "scalar"; name: PrismaScalar; list: boolean }
  | { kind: "enum"; name: string; values: string[]; list: boolean }
  | { kind: "relation"; to: EntityId; list: boolean }
  | { kind: "unsupported"; raw: string };

export type ModuleRole = "declaration" | "route" | "handler" | "prisma-schema" | "test" | "config" | "other";

export type GeneratedTestSuite =
  | "auth-matrix"
  | "precondition"
  | "postcondition"
  | "event"
  | "consumer"
  | "invariant"
  | "pitfall.webhook-signature"
  | "pitfall.idempotency"
  | "pitfall.raw-body";

export interface TestResultSummary {
  status: "passed" | "failed" | "skipped" | "unknown";
  at: string;
  /** Contract ids whose assertions failed, when status is "failed". */
  failedContracts?: ContractId[];
}

// ---------------------------------------------------------------------------
// 5. Nodes
// ---------------------------------------------------------------------------

export interface NodeBase {
  id: NodeId;
  kind: NodeKind;
  /** Short display name (the qualifier for most kinds). */
  name: string;
  /** One line, <= 200 chars, used by `find`. Derived; never authored. */
  summary: string;
  provenance: Provenance;
  /** Primary source span (declaration site, route registration, model block). */
  src: SourceRange | null;
  /** Human intent. Recommended on declared nodes; required on exposed Actions in declared mode (A2105); never on extracted nodes. */
  intent?: string;
  /** Owning team or person, free text as written. */
  owner?: string;
  tags?: string[];
}

export interface EntityNode extends NodeBase {
  kind: "Entity";
  /** Prisma model name as written in schema.prisma (= the entity name). */
  model: string;
  /** Prisma client accessor, always `Uncapitalize(model)` (`OAuthToken` -> `oAuthToken`). Derived, never declared. */
  clientName: string;
  fields: FieldId[];
  /** Field names forming the primary key (`@id` or `@@id`), in schema order. */
  idFields: string[];
  /** Unique constraints: each inner list is one `@unique` field or one `@@unique([...])` group. */
  uniques: string[][];
  /** Invariant contracts (phase "invariant"). */
  invariants: ContractId[];
}

export interface FieldNode extends NodeBase {
  kind: "Field";
  entity: EntityId;
  type: FieldType;
  optional: boolean;
  isId: boolean;
  unique: boolean;
  hasDefault: boolean;
}

export interface ActionNode extends NodeBase {
  kind: "Action";
  mode: ActionMode;
  route: RouteBinding | null;
  input: InputSpec;
  output: OutputSpec;
  policy: PolicyId | null;
  /** True when declared `public: true`; mutually exclusive with `policy`. */
  public: boolean;
  /** Subject entity whose row backs `self.*` / `old.*`. Null when the action has no subject. */
  subject: { entity: EntityId; where: DbWhere } | null;
  contracts: ContractId[];
  effects: EffectsSpec;
  /** Declared mode only; observe mode is always false. The Prisma timeout passthrough is a runtime option, not an IR fact. */
  transaction: boolean;
  /** Fact only in V0: drives the `pitfall.idempotency` test and A5002. */
  idempotency: IdempotencySpec | null;
  /** The `run` function (declared) or the referenced `handler` (observe; null when the declaration gives none). */
  handler: SymbolRef | null;
  ratios: { opaqueGuards: number; totalContracts: number; handlerLines: number };
}

export interface QueryNode extends NodeBase {
  kind: "Query";
  mode: ActionMode;
  route: RouteBinding | null;
  input: InputSpec;
  output: OutputSpec;
  policy: PolicyId | null;
  public: boolean;
  /** Verified reads only; queries may not write (A4004 if a write is found). */
  reads: EntityId[];
  handler: SymbolRef | null;
  ratios: { handlerLines: number };
}

export interface PolicyNode extends NodeBase {
  kind: "Policy";
  /** The single `allow` contract (phase "allow"). */
  allow: ContractId;
  tier: ContractTier;
  /** Actions, Queries and Exposures authorized by this policy (mirror of `authorizes` edges). */
  appliesTo: Array<ActionId | QueryId | ExposureId>;
}

export interface ContractNode extends NodeBase {
  kind: "Contract";
  /** Owning node (Action, Query, Entity or Policy). */
  of: ActionId | QueryId | EntityId | PolicyId;
  phase: ContractPhase;
  /** Clause name as written (`notAlreadyMember`). For policies it is `allow`. */
  clause: string;
  tier: ContractTier;
  /** Absent for guards. */
  expr: BoolExpr | null;
  opaque: boolean;
  /** Optional human message shown on violation; defaults to a rendering of expr. */
  message?: string;
}

export interface EventNode extends NodeBase {
  kind: "Event";
  payload: Record<string, PayloadType>;
  /** Declared `external: true`: consumed outside this repo, so A4003 is suppressed. */
  external: boolean;
}

export interface WorkflowNode extends NodeBase {
  kind: "Workflow";
  on: EventId;
  engine: WorkflowEngine;
  runner: SymbolRef | null;
  retry: RetrySpec | null;
  /** Step names discovered by scanning the runner (`step.run("email", ...)`). */
  steps: string[];
}

export interface IntegrationNode extends NodeBase {
  kind: "Integration";
  client: SymbolRef | null;
  webhook: {
    /** Header carrying the signature, e.g. `stripe-signature`. */
    verify: string;
    /** How the generated pitfall tests sign a body. */
    scheme: WebhookScheme;
    /** Environment variable holding the signing secret in tests; null only for `scheme: "custom"`. */
    secretEnv: string | null;
    rawBody: boolean;
    /** Exposure handling the webhook, when matched. */
    exposure: ExposureId | null;
  } | null;
  idempotency: IdempotencySpec | null;
  /** Calls to this integration must not happen inside a Averr-owned transaction (A4005, checked by effect-scan). */
  nonTransactional: boolean;
}

export interface ExposureNode extends NodeBase {
  kind: "Exposure";
  router: Router;
  method: HttpMethod;
  /** Full composed path: mount prefixes (`app.route("/teams", r)`, `basePath`, `app.use("/teams", r)`) + registered path, normalised per SPEC-IR §4.1. */
  path: string;
  handler: SymbolRef | null;
  /**
   * Middleware identifiers in effective order, as written: path-level `use()` middleware whose pattern
   * matches this path first (`auth()` from `app.use("/teams/*", auth())`), then inline arguments
   * (`requireRole("admin")`).
   */
  middleware: string[];
  /** Action or Query this route is bound to, when a declaration's route matched. */
  boundTo: ActionId | QueryId | null;
  /** Zod schema found in a validator middleware or in the handler, if any. */
  bodySchema: SymbolRef | null;
  /** True when the registration is on a dynamically mounted router or built from non-literal values. */
  dynamic: boolean;
  /** Declared `public: true` on the bound Action/Query, or the configured `publicMarker` middleware is present. */
  public: boolean;
}

export interface TestNode extends NodeBase {
  kind: "Test";
  generated: boolean;
  suite: GeneratedTestSuite | "hand-written";
  file: string;
  title: string;
  /** Nodes this test verifies (mirror of `verifiedBy` edges). */
  covers: NodeId[];
  lastResult: TestResultSummary | null;
  /**
   * Generated tests only. Hash of the declaration content the suite derives from, computed from the
   * graph (generated Test nodes are DERIVED from declarations, not extracted from the generated file).
   * A6001 compares it with the `@generated ... hash:<sourceHash>` header of the file on disk.
   */
  sourceHash?: string;
}

export interface ModuleNode extends NodeBase {
  kind: "Module";
  file: string;
  role: ModuleRole;
  exports: string[];
  /** sha256 of file content at build time. */
  hash: string;
  lines: number;
}

export type Node =
  | EntityNode
  | FieldNode
  | ActionNode
  | QueryNode
  | PolicyNode
  | ContractNode
  | EventNode
  | WorkflowNode
  | IntegrationNode
  | ExposureNode
  | TestNode
  | ModuleNode;

export type NodeOfKind<K extends NodeKind> = Extract<Node, { kind: K }>;

// ---------------------------------------------------------------------------
// 6. Edges
// ---------------------------------------------------------------------------

/**
 * Edge kinds and their permitted endpoints. Direction is `from -> to`.
 *
 * | kind          | from                                    | to                              | meaning |
 * |---------------|-----------------------------------------|---------------------------------|---------|
 * | contains      | Module                                  | any                             | file contains declaration/registration |
 * | contains      | Entity                                  | Field                           | model has field |
 * | constrains    | Contract                                | Action, Query, Entity, Policy   | clause belongs to owner |
 * | authorizes    | Policy                                  | Action, Query, Exposure         | policy gates it |
 * | exposes       | Exposure                                | Action, Query                   | route serves it |
 * | returns       | Action, Query                           | Entity                          | output entity |
 * | validatesWith | Action, Query, Exposure                 | Module (attrs.symbol = Zod)     | input schema |
 * | implementedBy | Action, Query                           | Module (attrs.symbol = handler) | run/handler location |
 * | reads         | Action, Query, Policy, Contract         | Entity                          | reads rows |
 * | writes        | Action, Workflow                        | Entity                          | writes rows |
 * | emits         | Action, Workflow                        | Event                           | emits event |
 * | consumedBy    | Event                                   | Workflow, Integration           | event consumer |
 * | calls         | Action, Query, Workflow                 | Integration                     | foreign call |
 * | persistedBy   | Entity                                  | Module (prisma schema)          | model source |
 * | verifiedBy    | Action, Query, Policy, Contract, Event, Workflow, Integration, Exposure | Test | test covers it |
 * | dependsOn     | any                                     | any                             | computed propagation for impact (never authored); X dependsOn Y means "X is affected when Y changes" |
 */
export const EDGE_KINDS = [
  "contains",
  "constrains",
  "authorizes",
  "exposes",
  "returns",
  "validatesWith",
  "implementedBy",
  "reads",
  "writes",
  "emits",
  "consumedBy",
  "calls",
  "persistedBy",
  "verifiedBy",
  "dependsOn",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Edge {
  kind: EdgeKind;
  from: NodeId;
  to: NodeId;
  provenance: Provenance;
  /** Kind-specific attributes, e.g. `{ symbol: "InviteMember.input" }` on validatesWith, `{ model: "invitation" }` on persistedBy, `{ via: NodeId[] }` on dependsOn. */
  attrs?: Record<string, string | number | boolean | string[]>;
}

// ---------------------------------------------------------------------------
// 7. Graph container
// ---------------------------------------------------------------------------

export const GRAPH_SCHEMA_VERSION = 1 as const;

export interface StackSummary {
  orm: "prisma";
  prismaSchema: string | null;
  routers: Router[];
  validator: "zod" | null;
  testRunner: "vitest" | null;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  /** Files registering the HTTP app (`src/index.ts`, `src/app.ts`). */
  entryPoints: string[];
  commands: { build: string | null; test: string | null; typecheck: string | null };
  /** <= 5 lines, derived from repo conventions (error shape, pagination, auth middleware). */
  conventions: string[];
}

/** Health counters surfaced by `overview`. All are plain integers computed at build time. */
export interface HealthCounters {
  exposures: number;
  /**
   * Exposures with `public: false`, `boundTo: null`, and no middleware matching `config.authMiddleware`
   * (the A2103 warning set). Bound declarations cannot lack a policy when tsc passes.
   */
  exposuresWithoutPolicy: number;
  exposuresUndeclared: number;
  actionsDeclared: number;
  actionsObserve: number;
  queries: number;
  contracts: number;
  opaqueGuards: number;
  /**
   * Lines inside run/handler bodies vs total TS lines in the project. STAGE 2 METRIC: the ">40% means
   * primitives are too thin" reading only applies once declarations derive code; in V0 observe mode it
   * measures the size of existing handlers and `overview` labels it "informational".
   */
  handlerLines: number;
  totalLines: number;
  eventsWithoutConsumer: number;
  staleGeneratedTests: number;
  /** Extracted nodes with confidence < 0.9. */
  lowConfidenceNodes: number;
  errors: number;
  warnings: number;
}

export interface GraphMeta {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  averrVersion: string;
  /** ISO-8601 UTC. */
  builtAt: string;
  /** HEAD commit sha, or null outside git. */
  commit: string | null;
  /** True when the working tree differs from HEAD. */
  dirty: boolean;
  /** sha256 over the sorted (path, content-hash) list of all input files (SPEC-IR §6). The staleness key and the snapshot key. */
  contentHash: string;
  /** Absolute path of the project root at build time (not used for identity). */
  root: string;
  stack: StackSummary;
  counts: Record<NodeKind, number>;
  health: HealthCounters;
}

export interface Graph {
  meta: GraphMeta;
  nodes: Record<NodeId, Node>;
  edges: Edge[];
  /** Diagnostics produced by this build (compiler checks only; test results live in check output). */
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// 8. History and structural diff (computed from two graphs; never stored in the cache)
// ---------------------------------------------------------------------------

export type GraphDiffOpKind =
  | "add"
  | "remove"
  | "rename"
  | "change"
  | "add-contract"
  | "remove-contract"
  | "weaken-contract"
  | "strengthen-contract"
  | "add-edge"
  | "remove-edge";

export interface GraphDiffOp {
  op: GraphDiffOpKind;
  /** Primary node affected. For `add-edge`/`remove-edge` it is the edge's `from`. */
  node: NodeId;
  /** For rename: the previous id. For contract ops: the contract id. For edge ops: `<kind>:<from>-><to>`. For change: the dotted property path. */
  target?: string;
  before?: unknown;
  after?: unknown;
}

export interface GraphDiff {
  base: { commit: string | null; contentHash: string };
  head: { commit: string | null; contentHash: string };
  ops: GraphDiffOp[];
}

export interface HistoryEntry {
  commit: string;
  at: string;
  author?: string;
  op: GraphDiffOpKind;
  target?: string;
}

// ---------------------------------------------------------------------------
// 9. Diagnostics
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

export interface CauseLink {
  node: NodeId;
  /** One line; states the fact that holds at this node. */
  why: string;
}

/**
 * A proposed fix. Only diagnostics whose code has `deterministicFix: true` MAY carry fixes.
 * `evidence` is a sentence, never a confidence number. At least one of `patch` (a unified diff against
 * the working tree, applicable with `git apply`, <= 4 000 chars, excluded from the 300-token budget)
 * or `command` (a shell command that performs the fix, e.g. `averr testgen --only Test:gen/...`) MUST be present.
 */
export interface Fix {
  label: string;
  evidence: string;
  patch?: string;
  command?: string;
}

export type DocsUri = `averr://docs/${string}`;

export interface Diagnostic {
  id: DiagnosticId;
  code: DiagnosticCode;
  severity: Severity;
  /** <= 80 chars, states the violated fact. */
  title: string;
  /** Optional one-paragraph detail. The diagnostic MINUS `fixes[].patch` MUST serialise to <= 300 tokens (~1200 chars). */
  message?: string;
  node: NodeId | null;
  /** `file:line` of the best place to look; derived from `src` when present. */
  path: string | null;
  src: SourceRange | null;
  /** Root cause first. One root cause per cascade where attribution succeeds. */
  cause: CauseLink[];
  /** <= 5 ids. */
  related: NodeId[];
  fixes: Fix[];
  /** Summary of the graph diff since the last green `check`, e.g. "+1 action, +1 route". Null when no green build is recorded. */
  since_last_green: string | null;
  /** MCP resource URI of the construct's semantics card, e.g. `averr://docs/policy`. */
  docs: DocsUri | null;
}

export interface DiagnosticCodeInfo {
  code: string;
  /** Registry severity is the MAXIMUM; a rule MAY lower it for a documented sub-case, never raise it. */
  severity: Severity;
  title: string;
  /** When true, the compiler MAY attach a Fix when the documented precondition holds; when false it MUST attach none. */
  deterministicFix: boolean;
  /** Construct whose semantics card explains the rule. */
  docs: DocsUri;
}

/**
 * Diagnostic code registry. Families:
 *   S1xxx identity and declarations · S2xxx exposure and policy · S3xxx contracts
 *   S4xxx effects, events, workflows · S5xxx integrations and pitfalls · S6xxx tests
 *   S7xxx extraction and graph health · S9xxx backstops (tsc, vitest)
 * Codes are append-only; a retired code is never reused. Gaps are deliberate:
 *   A2102 is RESERVED (never issued; the FINAL doc's W2103 numbering is kept so A2103 keeps its meaning).
 *   A2107 is RESERVED for the Stage 2 tenant-key check ("Policy does not constrain tenant key").
 */
export const DIAGNOSTIC_CODES = {
  A1001: { code: "A1001", severity: "error", title: "Duplicate declaration id", deterministicFix: false, docs: "averr://docs/identity" },
  A1002: { code: "A1002", severity: "warning", title: "Declaration renamed (same run/handler reference, new id)", deterministicFix: false, docs: "averr://docs/identity" },
  A1003: { code: "A1003", severity: "error", title: "Unknown Prisma model", deterministicFix: false, docs: "averr://docs/entity" },
  A1004: { code: "A1004", severity: "error", title: "Declaration option is not statically analysable", deterministicFix: false, docs: "averr://docs/identity" },
  A1005: { code: "A1005", severity: "warning", title: "Declaration keys out of canonical order", deterministicFix: false, docs: "averr://docs/identity" },
  A2101: { code: "A2101", severity: "error", title: "Declared route has no matching exposure", deterministicFix: true, docs: "averr://docs/action" },
  A2103: { code: "A2103", severity: "error", title: "Exposed route has no policy", deterministicFix: true, docs: "averr://docs/policy" },
  A2104: { code: "A2104", severity: "warning", title: "Exposure has no declaration", deterministicFix: false, docs: "averr://docs/action" },
  A2105: { code: "A2105", severity: "error", title: "Exposed declared-mode action has no intent", deterministicFix: false, docs: "averr://docs/action" },
  A2106: { code: "A2106", severity: "warning", title: "Policy is an opaque guard; auth matrix not derivable", deterministicFix: false, docs: "averr://docs/policy" },
  A3001: { code: "A3001", severity: "error", title: "self/old reference without a subject", deterministicFix: false, docs: "averr://docs/contracts" },
  A3002: { code: "A3002", severity: "error", title: "Contract references unknown field", deterministicFix: true, docs: "averr://docs/contracts" },
  A3003: { code: "A3003", severity: "error", title: "Reference root or form not allowed in this phase", deterministicFix: false, docs: "averr://docs/contracts" },
  A3004: { code: "A3004", severity: "error", title: "Reference path deeper than 3 segments", deterministicFix: false, docs: "averr://docs/contracts" },
  A3005: { code: "A3005", severity: "warning", title: "Guard could be an expression or predicate", deterministicFix: false, docs: "averr://docs/contracts" },
  A3006: { code: "A3006", severity: "error", title: "Zod input field drifts from Prisma field type", deterministicFix: true, docs: "averr://docs/entity" },
  A3007: { code: "A3007", severity: "error", title: "Literal string on the right of a comparison looks like a reference", deterministicFix: true, docs: "averr://docs/contracts" },
  A3008: { code: "A3008", severity: "error", title: "Operator not applicable to operand type", deterministicFix: false, docs: "averr://docs/contracts" },
  A3009: { code: "A3009", severity: "error", title: "where path crosses a list relation or nests a db predicate", deterministicFix: false, docs: "averr://docs/contracts" },
  A3010: { code: "A3010", severity: "error", title: "Reference root looks misspelled", deterministicFix: true, docs: "averr://docs/contracts" },
  A4001: { code: "A4001", severity: "error", title: "Emitted event is not declared", deterministicFix: true, docs: "averr://docs/event" },
  A4002: { code: "A4002", severity: "warning", title: "Declared effects differ from verified effects", deterministicFix: true, docs: "averr://docs/action" },
  A4003: { code: "A4003", severity: "warning", title: "Event has no consumer", deterministicFix: false, docs: "averr://docs/event" },
  A4004: { code: "A4004", severity: "error", title: "Query handler writes to the database", deterministicFix: false, docs: "averr://docs/query" },
  A4005: { code: "A4005", severity: "error", title: "Integration called inside a Averr-owned transaction", deterministicFix: false, docs: "averr://docs/integration" },
  A5001: { code: "A5001", severity: "warning", title: "Webhook route appears to parse body before signature verification", deterministicFix: false, docs: "averr://docs/integration" },
  A5002: { code: "A5002", severity: "warning", title: "Webhook or payment handler has no idempotency", deterministicFix: false, docs: "averr://docs/integration" },
  A6001: { code: "A6001", severity: "warning", title: "Generated test is stale", deterministicFix: true, docs: "averr://docs/tests" },
  A7001: { code: "A7001", severity: "info", title: "Extracted node below confidence threshold", deterministicFix: false, docs: "averr://docs/graph" },
  A9001: { code: "A9001", severity: "error", title: "TypeScript error (tsc backstop, cascade-collapsed)", deterministicFix: false, docs: "averr://docs/check" },
  A9002: { code: "A9002", severity: "error", title: "Test failed", deterministicFix: false, docs: "averr://docs/check" },
} as const satisfies Record<string, DiagnosticCodeInfo>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

// ---------------------------------------------------------------------------
// 10. Zod schemas (zod 4) for validating the .averr/graph.json cache and tool output
// ---------------------------------------------------------------------------

const nodeIdRe = new RegExp(`^(${NODE_KINDS.join("|")}):.+$`);
export const NodeIdSchema = z.string().regex(nodeIdRe) as unknown as z.ZodType<NodeId>;
const idOf = <K extends NodeKind>(kind: K) =>
  z.string().regex(new RegExp(`^${kind}:.+$`)) as unknown as z.ZodType<`${K}:${string}`>;

export const PositionSchema = z.tuple([z.number().int().min(1), z.number().int().min(0)]) as unknown as z.ZodType<Position>;
export const SourceRangeSchema: z.ZodType<SourceRange> = z.object({
  file: z.string(),
  range: z.tuple([PositionSchema, PositionSchema]),
});
export const SymbolRefSchema: z.ZodType<SymbolRef> = z.object({
  file: z.string(),
  symbol: z.string(),
  range: SourceRangeSchema.optional(),
});

export const EvidenceSchema: z.ZodType<Evidence> = z.object({
  kind: z.enum(["source", "call", "import", "schema", "route", "test", "trace"]),
  note: z.string(),
  src: SourceRangeSchema.optional(),
});

const verifierId = z.enum(["effect-scan", "route-match", "zod-match", "emit-scan", "consumer-scan", "test-link"]);

export const ProvenanceSchema: z.ZodType<Provenance> = z.discriminatedUnion("origin", [
  z.object({
    origin: z.literal("extracted"),
    extractor: z.enum(["prisma", "hono", "express", "zod", "ts-handler", "vitest"]),
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceSchema),
  }),
  z.object({ origin: z.literal("declared"), declaredAt: SourceRangeSchema }),
  z.object({
    origin: z.literal("verified"),
    declaredAt: SourceRangeSchema,
    verifiers: z.array(verifierId).min(1),
    evidence: z.array(EvidenceSchema),
  }),
]);

// --- contract AST ---
const refPathRe = /^(input|result|actor|self|old)\.[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,2}$/;
export const RefSchema = z.object({ ref: z.string().regex(refPathRe) }) as unknown as z.ZodType<Ref>;
const litScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const LitSchema: z.ZodType<Lit> = z.object({ lit: z.union([litScalar, z.array(litScalar)]) });
export const LenExprSchema: z.ZodType<LenExpr> = z.object({ op: z.literal("len"), arg: RefSchema });
export const DbWhereOperandSchema: z.ZodType<DbWhereOperand> = z.union([RefSchema, LitSchema, LenExprSchema]);

export const DbWhereValueSchema: z.ZodType<DbWhereValue> = z.union([
  RefSchema,
  LitSchema,
  z.object({ in: z.union([LitSchema, RefSchema]) }),
  z.object({ not: z.union([RefSchema, LitSchema]) }),
  z.object({ lt: DbWhereOperandSchema }),
  z.object({ lte: DbWhereOperandSchema }),
  z.object({ gt: DbWhereOperandSchema }),
  z.object({ gte: DbWhereOperandSchema }),
]);
export const DbWhereSchema: z.ZodType<DbWhere> = z.record(z.string(), DbWhereValueSchema);

export const OperandSchema: z.ZodType<Operand> = z.lazy(() =>
  z.union([
    RefSchema,
    LitSchema,
    LenExprSchema,
    z.object({ op: z.literal("sum"), path: RefSchema, field: z.string() }),
    z.object({ op: z.literal("count"), path: RefSchema, where: BoolExprSchema.optional() }),
    z.object({ op: z.literal("db.countWhere"), model: z.string(), where: DbWhereSchema }),
  ]),
);

export const BoolExprSchema: z.ZodType<BoolExpr> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]), lhs: OperandSchema, rhs: OperandSchema }),
    z.object({ op: z.literal("and"), args: z.array(BoolExprSchema).min(1) }),
    z.object({ op: z.literal("or"), args: z.array(BoolExprSchema).min(1) }),
    z.object({ op: z.literal("not"), arg: BoolExprSchema }),
    z.object({ op: z.literal("in"), lhs: OperandSchema, rhs: z.union([LitSchema, RefSchema]) }),
    z.object({ op: z.literal("isNull"), arg: RefSchema }),
    z.object({ op: z.literal("exists"), path: RefSchema, where: BoolExprSchema.optional() }),
    z.object({
      op: z.literal("emitted"),
      event: idOf("Event"),
      count: z
        .union([
          z.number().int().min(0),
          z.object({ min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }),
        ])
        .optional(),
    }),
    z.object({ op: z.enum(["db.exists", "db.none", "db.unique"]), model: z.string(), where: DbWhereSchema }),
  ]),
);

// --- shared fragments ---
export const EffectSchema = z.enum(EFFECTS);
export const HttpMethodSchema = z.enum(HTTP_METHODS);
export const RouterSchema = z.enum(ROUTERS);
export const WebhookSchemeSchema = z.enum(WEBHOOK_SCHEMES);
export const RouteBindingSchema: z.ZodType<RouteBinding> = z.object({
  method: HttpMethodSchema,
  path: z.string(),
  exposure: idOf("Exposure").nullable(),
  verified: z.boolean(),
});
export const InputSpecSchema: z.ZodType<InputSpec> = z.object({ zod: SymbolRefSchema.nullable(), fields: z.array(z.string()) });
export const OutputSpecSchema: z.ZodType<OutputSpec> = z.union([
  z.object({ entity: idOf("Entity") }),
  z.object({ zod: SymbolRefSchema }),
  z.object({ kind: z.literal("void") }),
  z.object({ kind: z.literal("unknown") }),
]);
export const EffectsSpecSchema: z.ZodType<EffectsSpec> = z.object({
  declared: z.array(EffectSchema),
  verified: z.object({
    reads: z.array(idOf("Entity")),
    writes: z.array(idOf("Entity")),
    emits: z.array(idOf("Event")),
    calls: z.array(idOf("Integration")),
    complete: z.boolean(),
  }),
});
export const IdempotencySpecSchema: z.ZodType<IdempotencySpec> = z.object({
  key: z.union([z.object({ header: z.string() }), z.object({ input: z.string() })]),
  ttlSeconds: z.number().int().positive(),
});
export const RetrySpecSchema: z.ZodType<RetrySpec> = z.object({
  attempts: z.number().int().min(0),
  backoff: z.enum(["fixed", "exponential"]).optional(),
});
export const FieldTypeSchema: z.ZodType<FieldType> = z.union([
  z.object({
    kind: z.literal("scalar"),
    name: z.enum(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"]),
    list: z.boolean(),
  }),
  z.object({ kind: z.literal("enum"), name: z.string(), values: z.array(z.string()), list: z.boolean() }),
  z.object({ kind: z.literal("relation"), to: idOf("Entity"), list: z.boolean() }),
  z.object({ kind: z.literal("unsupported"), raw: z.string() }),
]);
export const TestResultSummarySchema: z.ZodType<TestResultSummary> = z.object({
  status: z.enum(["passed", "failed", "skipped", "unknown"]),
  at: z.string(),
  failedContracts: z.array(idOf("Contract")).optional(),
});

const nodeBase = {
  id: NodeIdSchema,
  name: z.string(),
  summary: z.string().max(200),
  provenance: ProvenanceSchema,
  src: SourceRangeSchema.nullable(),
  intent: z.string().optional(),
  owner: z.string().optional(),
  tags: z.array(z.string()).optional(),
};

const contractTier = z.enum(["expr", "predicate", "guard"]);
const contractPhase = z.enum(["requires", "ensures", "invariant", "allow"]);
const actionMode = z.enum(["declared", "observe"]);
const subjectSchema = z.object({ entity: idOf("Entity"), where: DbWhereSchema }).nullable();

export const EntityNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Entity"),
  model: z.string(),
  clientName: z.string(),
  fields: z.array(idOf("Field")),
  idFields: z.array(z.string()),
  uniques: z.array(z.array(z.string())),
  invariants: z.array(idOf("Contract")),
});
export const FieldNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Field"),
  entity: idOf("Entity"),
  type: FieldTypeSchema,
  optional: z.boolean(),
  isId: z.boolean(),
  unique: z.boolean(),
  hasDefault: z.boolean(),
});
export const ActionNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Action"),
  mode: actionMode,
  route: RouteBindingSchema.nullable(),
  input: InputSpecSchema,
  output: OutputSpecSchema,
  policy: idOf("Policy").nullable(),
  public: z.boolean(),
  subject: subjectSchema,
  contracts: z.array(idOf("Contract")),
  effects: EffectsSpecSchema,
  transaction: z.boolean(),
  idempotency: IdempotencySpecSchema.nullable(),
  handler: SymbolRefSchema.nullable(),
  ratios: z.object({ opaqueGuards: z.number().int(), totalContracts: z.number().int(), handlerLines: z.number().int() }),
});
export const QueryNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Query"),
  mode: actionMode,
  route: RouteBindingSchema.nullable(),
  input: InputSpecSchema,
  output: OutputSpecSchema,
  policy: idOf("Policy").nullable(),
  public: z.boolean(),
  reads: z.array(idOf("Entity")),
  handler: SymbolRefSchema.nullable(),
  ratios: z.object({ handlerLines: z.number().int() }),
});
export const PolicyNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Policy"),
  allow: idOf("Contract"),
  tier: contractTier,
  appliesTo: z.array(z.union([idOf("Action"), idOf("Query"), idOf("Exposure")])),
});
export const ContractNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Contract"),
  of: z.union([idOf("Action"), idOf("Query"), idOf("Entity"), idOf("Policy")]),
  phase: contractPhase,
  clause: z.string(),
  tier: contractTier,
  expr: BoolExprSchema.nullable(),
  opaque: z.boolean(),
  message: z.string().optional(),
});
export const EventNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Event"),
  payload: z.record(z.string(), z.enum(PAYLOAD_TYPES)),
  external: z.boolean(),
});
export const WorkflowNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Workflow"),
  on: idOf("Event"),
  engine: z.enum(["inngest", "pg-boss", "custom"]),
  runner: SymbolRefSchema.nullable(),
  retry: RetrySpecSchema.nullable(),
  steps: z.array(z.string()),
});
export const IntegrationNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Integration"),
  client: SymbolRefSchema.nullable(),
  webhook: z
    .object({
      verify: z.string(),
      scheme: WebhookSchemeSchema,
      secretEnv: z.string().nullable(),
      rawBody: z.boolean(),
      exposure: idOf("Exposure").nullable(),
    })
    .nullable(),
  idempotency: IdempotencySpecSchema.nullable(),
  nonTransactional: z.boolean(),
});
export const ExposureNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Exposure"),
  router: RouterSchema,
  method: HttpMethodSchema,
  path: z.string(),
  handler: SymbolRefSchema.nullable(),
  middleware: z.array(z.string()),
  boundTo: z.union([idOf("Action"), idOf("Query")]).nullable(),
  bodySchema: SymbolRefSchema.nullable(),
  dynamic: z.boolean(),
  public: z.boolean(),
});
export const TestNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Test"),
  generated: z.boolean(),
  suite: z.enum([
    "auth-matrix",
    "precondition",
    "postcondition",
    "event",
    "consumer",
    "invariant",
    "pitfall.webhook-signature",
    "pitfall.idempotency",
    "pitfall.raw-body",
    "hand-written",
  ]),
  file: z.string(),
  title: z.string(),
  covers: z.array(NodeIdSchema),
  lastResult: TestResultSummarySchema.nullable(),
  sourceHash: z.string().optional(),
});
export const ModuleNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("Module"),
  file: z.string(),
  role: z.enum(["declaration", "route", "handler", "prisma-schema", "test", "config", "other"]),
  exports: z.array(z.string()),
  hash: z.string(),
  lines: z.number().int().min(0),
});

/**
 * Drift detection between the TS node types and their zod schemas (SPEC-IR §11): each node schema's
 * output type must be mutually assignable with the TS interface, so adding a field to one side without
 * the other fails `tsc`. The schemas stay `ZodObject`s (not `ZodType<T>`) so `discriminatedUnion` keeps
 * working; these aliases are the check.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
export type _SchemaDriftChecks = [
  AssertTrue<MutuallyAssignable<z.output<typeof EntityNodeSchema>, EntityNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof FieldNodeSchema>, FieldNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof ActionNodeSchema>, ActionNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof QueryNodeSchema>, QueryNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof PolicyNodeSchema>, PolicyNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof ContractNodeSchema>, ContractNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof EventNodeSchema>, EventNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof WorkflowNodeSchema>, WorkflowNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof IntegrationNodeSchema>, IntegrationNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof ExposureNodeSchema>, ExposureNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof TestNodeSchema>, TestNode>>,
  AssertTrue<MutuallyAssignable<z.output<typeof ModuleNodeSchema>, ModuleNode>>,
];

export const NodeSchema: z.ZodType<Node> = z.discriminatedUnion("kind", [
  EntityNodeSchema,
  FieldNodeSchema,
  ActionNodeSchema,
  QueryNodeSchema,
  PolicyNodeSchema,
  ContractNodeSchema,
  EventNodeSchema,
  WorkflowNodeSchema,
  IntegrationNodeSchema,
  ExposureNodeSchema,
  TestNodeSchema,
  ModuleNodeSchema,
]);

export const EdgeSchema: z.ZodType<Edge> = z.object({
  kind: z.enum(EDGE_KINDS),
  from: NodeIdSchema,
  to: NodeIdSchema,
  provenance: ProvenanceSchema,
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
});

export const DiagnosticCodeSchema = z.enum(Object.keys(DIAGNOSTIC_CODES) as [DiagnosticCode, ...DiagnosticCode[]]);

const docsUri = z.string().regex(/^averr:\/\/docs\/[a-z][a-z0-9-]*$/) as unknown as z.ZodType<DocsUri>;

export const FixSchema: z.ZodType<Fix> = z
  .object({ label: z.string(), evidence: z.string(), patch: z.string().max(4000).optional(), command: z.string().optional() })
  .refine((f) => f.patch !== undefined || f.command !== undefined, { message: "a Fix needs a patch or a command" });

export const DiagnosticSchema: z.ZodType<Diagnostic> = z.object({
  id: z.string().regex(/^D-\d{4,}$/) as unknown as z.ZodType<DiagnosticId>,
  code: DiagnosticCodeSchema,
  severity: z.enum(["error", "warning", "info"]),
  title: z.string().max(80),
  message: z.string().optional(),
  node: NodeIdSchema.nullable(),
  path: z.string().nullable(),
  src: SourceRangeSchema.nullable(),
  cause: z.array(z.object({ node: NodeIdSchema, why: z.string() })),
  related: z.array(NodeIdSchema).max(5),
  fixes: z.array(FixSchema),
  since_last_green: z.string().nullable(),
  docs: docsUri.nullable(),
});

export const StackSummarySchema: z.ZodType<StackSummary> = z.object({
  orm: z.literal("prisma"),
  prismaSchema: z.string().nullable(),
  routers: z.array(RouterSchema),
  validator: z.literal("zod").nullable(),
  testRunner: z.literal("vitest").nullable(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "unknown"]),
  entryPoints: z.array(z.string()),
  commands: z.object({ build: z.string().nullable(), test: z.string().nullable(), typecheck: z.string().nullable() }),
  conventions: z.array(z.string()).max(5),
});

export const HealthCountersSchema: z.ZodType<HealthCounters> = z.object({
  exposures: z.number().int(),
  exposuresWithoutPolicy: z.number().int(),
  exposuresUndeclared: z.number().int(),
  actionsDeclared: z.number().int(),
  actionsObserve: z.number().int(),
  queries: z.number().int(),
  contracts: z.number().int(),
  opaqueGuards: z.number().int(),
  handlerLines: z.number().int(),
  totalLines: z.number().int(),
  eventsWithoutConsumer: z.number().int(),
  staleGeneratedTests: z.number().int(),
  lowConfidenceNodes: z.number().int(),
  errors: z.number().int(),
  warnings: z.number().int(),
});

const countsShape = Object.fromEntries(NODE_KINDS.map((k) => [k, z.number().int().min(0)])) as Record<NodeKind, z.ZodNumber>;

export const GraphMetaSchema: z.ZodType<GraphMeta> = z.object({
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
  averrVersion: z.string(),
  builtAt: z.string(),
  commit: z.string().nullable(),
  dirty: z.boolean(),
  contentHash: z.string(),
  root: z.string(),
  stack: StackSummarySchema,
  counts: z.object(countsShape),
  health: HealthCountersSchema,
});

export const GraphSchema: z.ZodType<Graph> = z.object({
  meta: GraphMetaSchema,
  nodes: z.record(NodeIdSchema, NodeSchema),
  edges: z.array(EdgeSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export const GraphDiffSchema: z.ZodType<GraphDiff> = z.object({
  base: z.object({ commit: z.string().nullable(), contentHash: z.string() }),
  head: z.object({ commit: z.string().nullable(), contentHash: z.string() }),
  ops: z.array(
    z.object({
      op: z.enum([
        "add",
        "remove",
        "rename",
        "change",
        "add-contract",
        "remove-contract",
        "weaken-contract",
        "strengthen-contract",
        "add-edge",
        "remove-edge",
      ]),
      node: NodeIdSchema,
      target: z.string().optional(),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  ),
});
