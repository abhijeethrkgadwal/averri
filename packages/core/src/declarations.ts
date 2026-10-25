/**
 * The seven declaration constructors (SPEC-DECLARATIONS §5).
 *
 * Each returns a frozen plain object `{ kind, id | name, mode?, options }` (plus `id` for events) and
 * attaches a NON-ENUMERABLE `__averri` marker ({@link AverriMeta}) carrying the lowered contract records so
 * `@averri/contracts` can execute the declaration without re-deriving anything. The marker is invisible to
 * `JSON.stringify`, `Object.keys` and deep-equality, so the enumerable surface is exactly the typed shape.
 *
 * No registry, no import-time side effects (D-2): the compiler lowers the CALL EXPRESSION statically and
 * never sees these objects. Validation here is the runtime backstop for the types (hallucinated option
 * names, literal unions, `policy | public` XOR, `run | handler` XOR, `subject` for `self`/`old` refs).
 */
import type {
  ActionId,
  BoolExpr,
  ContractId,
  ContractPhase,
  ContractTier,
  DbWhere,
  Effect,
  EntityId,
  EventId,
  HttpMethod,
  IdempotencySpec,
  IntegrationId,
  PolicyId,
  QueryId,
  RetrySpec,
  RouteSpec,
  WorkflowEngine,
  WorkflowId,
} from "@averri/ir";
import type {
  ActionMode,
  AnyActionDecl,
  AnyGuardFn,
  AnyQueryDecl,
  Clause,
  Declaration,
  DeclarationApi,
  EntityDecl,
  EntityOptions,
  EventDecl,
  EventOptions,
  IntegrationDecl,
  IntegrationOptions,
  PascalName,
  PayloadShape,
  PolicyDecl,
  PolicyOptions,
  TransactionOptions,
  WorkflowDecl,
  WorkflowOptions,
} from "./types.js";
import { AverriDeclarationError, describe, isPlainObject } from "./errors.js";
import {
  CANONICAL_KEY_ORDERS,
  CLAUSE_NAME_RE,
  DECLARED_ID_RE,
  EFFECT_VALUES,
  HTTP_METHOD_VALUES,
  PASCAL_NAME_RE,
  PAYLOAD_TYPE_VALUES,
  PHASE_ROOTS,
  RETRY_BACKOFF_VALUES,
  WEBHOOK_SCHEME_VALUES,
  WORKFLOW_ENGINE_VALUES,
  type DeclarationKind,
} from "./literals.js";
import { collectRefs, containsEmitted, flattenWhere, isClause, isGuard, tierOf } from "./ast.js";
import { e, db, isEventDecl } from "./builders.js";

// ---------------------------------------------------------------------------
// Runtime marker
// ---------------------------------------------------------------------------

/** Property name of the non-enumerable runtime marker on every declaration object. */
export const AVERRI_MARKER = "__averri" as const;

/** One lowered contract clause, ready for `@averri/contracts`. Mirrors the IR `ContractNode` payload. */
export interface ContractRecord {
  /** `Contract:<owner>.<phase>.<clause>`; for policies `Contract:<policy>.allow`. */
  readonly id: ContractId;
  readonly phase: ContractPhase;
  /** Clause name; `null` for a policy's `allow`. */
  readonly clause: string | null;
  readonly tier: ContractTier;
  /** The AST for tier 1/2; `null` for guards. */
  readonly expr: BoolExpr | null;
  /** The guard function for tier 3; `null` otherwise. */
  readonly guard: AnyGuardFn | null;
  readonly opaque: boolean;
}

export interface SubjectMeta {
  readonly entity: EntityId;
  /** Prisma model name (= entity name). */
  readonly model: string;
  /** Prisma client accessor (`Uncapitalize(model)`). */
  readonly clientName: string;
  /** Canonical flat where (D-3). */
  readonly where: DbWhere;
}

export type AverriMeta =
  | { readonly kind: "entity"; readonly id: EntityId; readonly model: string; readonly clientName: string; readonly contracts: readonly ContractRecord[] }
  | { readonly kind: "policy"; readonly id: PolicyId; readonly tier: ContractTier; readonly contracts: readonly [ContractRecord] }
  | { readonly kind: "event"; readonly id: EventId; readonly external: boolean }
  | {
      readonly kind: "action";
      readonly id: ActionId;
      readonly mode: ActionMode;
      readonly public: boolean;
      readonly policy: PolicyId | null;
      readonly route: RouteSpec | null;
      readonly subject: SubjectMeta | null;
      /** Resolved: `true` by default in declared mode, `false` in observe mode (Averri owns no transaction there). */
      readonly transaction: TransactionOptions;
      readonly effects: readonly Effect[];
      readonly idempotency: IdempotencySpec | null;
      /** `requires` records then `ensures` records, each in source order. */
      readonly contracts: readonly ContractRecord[];
    }
  | {
      readonly kind: "query";
      readonly id: QueryId;
      readonly mode: ActionMode;
      readonly public: boolean;
      readonly policy: PolicyId | null;
      readonly route: RouteSpec | null;
    }
  | { readonly kind: "workflow"; readonly id: WorkflowId; readonly on: EventId; readonly engine: WorkflowEngine; readonly retry: RetrySpec | null }
  | {
      readonly kind: "integration";
      readonly id: IntegrationId;
      readonly nonTransactional: boolean;
      readonly effects: readonly Effect[];
      readonly hasWebhook: boolean;
    };

export type AverriMetaOf<K extends AverriMeta["kind"]> = Extract<AverriMeta, { kind: K }>;

/** True when `value` was produced by one of the @averri/core constructors. */
export function isDeclaration(value: unknown): value is Declaration {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, AVERRI_MARKER);
}

/** Reads the runtime marker. Throws when `decl` was not produced by @averri/core. */
export function averriMeta<D extends Declaration>(decl: D): AverriMetaOf<D["kind"]> {
  if (!isDeclaration(decl)) {
    throw new AverriDeclarationError("averriMeta", null, null, `expected a declaration produced by @averri/core, got ${describe(decl)}`);
  }
  return (decl as unknown as { [AVERRI_MARKER]: AverriMetaOf<D["kind"]> })[AVERRI_MARKER];
}

/** The IR node id of a declaration (`Action:Team.inviteMember`, `Entity:Invitation`, ...). */
export function declarationId(decl: Declaration): AverriMeta["id"] {
  return averriMeta(decl).id;
}

function attach<T extends object>(target: T, meta: AverriMeta): T {
  Object.defineProperty(target, AVERRI_MARKER, { value: Object.freeze(meta), enumerable: false, writable: false, configurable: false });
  return Object.freeze(target);
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

type Opts = Record<string, unknown>;

function fail(construct: string, id: string, option: string | null, detail: string): never {
  throw new AverriDeclarationError(construct, id, option, detail);
}

function requireOptions(construct: string, id: string, options: unknown, kind: DeclarationKind): Opts {
  if (!isPlainObject(options)) fail(construct, id, null, `expected an options object, got ${describe(options)}`);
  const allowed = CANONICAL_KEY_ORDERS[kind] as readonly string[];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      fail(construct, id, key, `unknown option (allowed: ${allowed.join(", ")})`);
    }
  }
  return options;
}

function requireDeclaredId(construct: string, id: unknown): string {
  if (typeof id !== "string") throw new AverriDeclarationError(construct, null, null, `expected an id string, got ${describe(id)}`);
  if (!DECLARED_ID_RE.test(id)) {
    fail(construct, id, null, `id must be "<Scope>.<name>" with a capitalised Scope and exactly one dot (e.g. "Team.inviteMember")`);
  }
  return id;
}

function requirePascalName(construct: string, name: unknown): string {
  if (typeof name !== "string") throw new AverriDeclarationError(construct, null, null, `expected a name string, got ${describe(name)}`);
  if (!PASCAL_NAME_RE.test(name)) fail(construct, name, null, `name must be PascalCase with no dots (e.g. "Invitation")`);
  return name;
}

function optionalString(construct: string, id: string, options: Opts, key: string): void {
  const value = options[key];
  if (value !== undefined && typeof value !== "string") fail(construct, id, key, `expected a string, got ${describe(value)}`);
}

function validateCommon(construct: string, id: string, options: Opts): void {
  optionalString(construct, id, options, "intent");
  optionalString(construct, id, options, "owner");
  const tags = options.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) fail(construct, id, "tags", `expected an array of strings, got ${describe(tags)}`);
  }
}

function literalUnion(construct: string, id: string, option: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(construct, id, option, `expected one of ${allowed.map((v) => JSON.stringify(v)).join(" | ")}, got ${describe(value)}`);
  }
}

function validateEffects(construct: string, id: string, option: string, value: unknown): readonly Effect[] {
  if (!Array.isArray(value)) fail(construct, id, option, `expected an array of effects, got ${describe(value)}`);
  value.forEach((effect, index) => literalUnion(construct, id, `${option}[${index}]`, effect, EFFECT_VALUES));
  const seen = new Set<string>();
  for (const effect of value as string[]) {
    if (seen.has(effect)) fail(construct, id, option, `duplicate effect ${JSON.stringify(effect)}`);
    seen.add(effect);
  }
  return Object.freeze([...(value as Effect[])]);
}

function validateRoute(construct: string, id: string, option: string, value: unknown): RouteSpec {
  if (!isPlainObject(value)) fail(construct, id, option, `expected { method, path }, got ${describe(value)}`);
  const extra = Object.keys(value).filter((k) => k !== "method" && k !== "path");
  if (extra.length > 0) fail(construct, id, option, `unknown keys ${JSON.stringify(extra)} (allowed: method, path)`);
  literalUnion(construct, id, `${option}.method`, value.method, HTTP_METHOD_VALUES);
  if (typeof value.path !== "string" || !value.path.startsWith("/")) {
    fail(construct, id, `${option}.path`, `expected a path template starting with "/", got ${describe(value.path)}`);
  }
  return Object.freeze({ method: value.method as HttpMethod, path: value.path });
}

function validateIdempotency(construct: string, id: string, option: string, value: unknown): IdempotencySpec {
  if (!isPlainObject(value)) fail(construct, id, option, `expected { key, ttlSeconds }, got ${describe(value)}`);
  const extra = Object.keys(value).filter((k) => k !== "key" && k !== "ttlSeconds");
  if (extra.length > 0) fail(construct, id, option, `unknown keys ${JSON.stringify(extra)} (allowed: key, ttlSeconds)`);
  const key = value.key;
  if (!isPlainObject(key)) fail(construct, id, `${option}.key`, `expected { header } or { input }, got ${describe(key)}`);
  const keyKeys = Object.keys(key);
  if (keyKeys.length !== 1 || (keyKeys[0] !== "header" && keyKeys[0] !== "input") || typeof key[keyKeys[0] as string] !== "string") {
    fail(construct, id, `${option}.key`, `expected exactly one of { header: string } or { input: string }, got ${JSON.stringify(key)}`);
  }
  const ttl = value.ttlSeconds;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
    fail(construct, id, `${option}.ttlSeconds`, `expected a positive number of seconds, got ${describe(ttl)}`);
  }
  return value as unknown as IdempotencySpec;
}

function isZodSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === "function" &&
    typeof (value as { parse?: unknown }).parse === "function"
  );
}

function isEntityDecl(value: unknown): value is EntityDecl {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "entity" && typeof (value as { name?: unknown }).name === "string";
}

function isPolicyDecl(value: unknown): value is PolicyDecl {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "policy" && typeof (value as { id?: unknown }).id === "string";
}

function validateOutput(construct: string, id: string, value: unknown): void {
  if (value === undefined || value === "void" || isEntityDecl(value) || isZodSchema(value)) return;
  if (typeof value === "string") {
    if (PASCAL_NAME_RE.test(value)) return;
    fail(construct, id, "output", `expected an entity name in PascalCase, an entity() declaration, a Zod schema or "void", got ${describe(value)}`);
  }
  fail(construct, id, "output", `expected an entity name, an entity() declaration, a Zod schema or "void", got ${describe(value)}`);
}

/** Validates a `requires`/`ensures`/`invariant` record and lowers it to contract records. */
function lowerClauses(
  construct: string,
  id: string,
  ownerQualifier: string,
  phase: ContractPhase,
  record: unknown,
  rules: { allowGuards: boolean; allowPredicates: boolean },
): ContractRecord[] {
  if (!isPlainObject(record)) fail(construct, id, phase, `expected an object of named clauses, got ${describe(record)}`);
  const out: ContractRecord[] = [];
  for (const name of Object.keys(record)) {
    const option = `${phase}.${name}`;
    if (name.startsWith("$")) fail(construct, id, option, `clause names starting with "$" are reserved for synthetic contracts (A1004)`);
    if (!CLAUSE_NAME_RE.test(name)) fail(construct, id, option, `clause name must be a camelCase identifier (e.g. "notAlreadyMember")`);
    const clause = record[name];
    if (!isClause(clause)) {
      fail(construct, id, option, `expected a clause built with e.*/db.* or a bare async guard function, got ${describe(clause)}`);
    }
    if (isGuard(clause)) {
      if (!rules.allowGuards) fail(construct, id, option, `guards are not allowed in ${phase}; use e.* expressions`);
      out.push(contractRecord(ownerQualifier, phase, name, "guard", null, clause as AnyGuardFn));
      continue;
    }
    const tier = tierOf(clause as Clause);
    if (tier === "predicate" && !rules.allowPredicates) {
      fail(construct, id, option, `${phase} clauses are expression-tier only (no db.* predicates)`);
    }
    checkRoots(construct, id, option, phase, (clause as { ast: BoolExpr }).ast);
    out.push(contractRecord(ownerQualifier, phase, name, tier, (clause as { ast: BoolExpr }).ast, null));
  }
  return out;
}

function contractRecord(
  ownerQualifier: string,
  phase: ContractPhase,
  clause: string | null,
  tier: ContractTier,
  expr: BoolExpr | null,
  guard: AnyGuardFn | null,
): ContractRecord {
  const suffix = clause === null ? phase : `${phase}.${clause}`;
  return Object.freeze({ id: `Contract:${ownerQualifier}.${suffix}` as ContractId, phase, clause, tier, expr, guard, opaque: tier === "guard" });
}

/** Reference roots per phase (SPEC-CONTRACTS §2) and `e.emitted` only in `ensures` (A3003). */
function checkRoots(construct: string, id: string, option: string, phase: ContractPhase, ast: BoolExpr): void {
  const allowed = PHASE_ROOTS[phase];
  for (const found of collectRefs(ast)) {
    if (!allowed.includes(found.root)) {
      fail(construct, id, option, `reference ${JSON.stringify(found.ref)} is not allowed in ${phase} (allowed roots: ${allowed.join(", ")}; A3003)`);
    }
  }
  if (phase !== "ensures" && containsEmitted(ast)) {
    fail(construct, id, option, `e.emitted() is only allowed in ensures (A3003)`);
  }
}

/** `self`/`old` refs (outside element scope) require `subject` (A3001). */
function checkSubjectRefs(construct: string, id: string, contracts: readonly ContractRecord[], hasSubject: boolean): void {
  if (hasSubject) return;
  for (const contract of contracts) {
    if (contract.expr === null) continue;
    for (const found of collectRefs(contract.expr)) {
      if (!found.inElementScope && (found.root === "self" || found.root === "old")) {
        fail(
          construct,
          id,
          `${contract.phase}.${contract.clause ?? ""}`,
          `reference ${JSON.stringify(found.ref)} needs a \`subject\` (the row behind self/old); declare subject: { entity, where } (A3001)`,
        );
      }
    }
  }
}

function uncapitalize(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function freezeOptions<T extends object>(options: Opts, plainKeys: readonly string[]): T {
  const copy: Opts = { ...options };
  for (const key of plainKeys) {
    const value = copy[key];
    if (isPlainObject(value)) copy[key] = Object.freeze({ ...value });
    else if (Array.isArray(value)) copy[key] = Object.freeze([...value]);
  }
  return Object.freeze(copy) as T;
}

// ---------------------------------------------------------------------------
// entity
// ---------------------------------------------------------------------------

function entityImpl(name: unknown, options: unknown = {}): EntityDecl {
  const construct = "entity";
  const n = requirePascalName(construct, name);
  const opts = requireOptions(construct, n, options, "entity");
  validateCommon(construct, n, opts);
  const contracts = opts.invariant === undefined ? [] : lowerClauses(construct, n, n, "invariant", opts.invariant, { allowGuards: false, allowPredicates: false });
  const decl = { kind: "entity" as const, name: n as PascalName, options: freezeOptions<EntityOptions>(opts, ["invariant", "tags"]) };
  return attach(decl, {
    kind: "entity",
    id: `Entity:${n}`,
    model: n,
    clientName: uncapitalize(n),
    contracts: Object.freeze(contracts),
  });
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

function policyImpl(id: unknown, options: unknown): PolicyDecl {
  const construct = "policy";
  const pid = requireDeclaredId(construct, id);
  const opts = requireOptions(construct, pid, options, "policy");
  validateCommon(construct, pid, opts);
  const allow = opts.allow;
  if (allow === undefined) fail(construct, pid, "allow", "required: a clause built with e.*/db.* or a bare async guard function");
  if (!isClause(allow)) fail(construct, pid, "allow", `expected a clause built with e.*/db.* or a bare async guard function, got ${describe(allow)}`);
  let record: ContractRecord;
  if (isGuard(allow)) {
    record = contractRecord(pid, "allow", null, "guard", null, allow as AnyGuardFn);
  } else {
    const ast = (allow as { ast: BoolExpr }).ast;
    checkRoots(construct, pid, "allow", "allow", ast);
    record = contractRecord(pid, "allow", null, tierOf(allow as Clause), ast, null);
  }
  const decl = { kind: "policy" as const, id: pid as PolicyDecl["id"], options: freezeOptions<PolicyOptions>(opts, ["tags"]) };
  return attach(decl, { kind: "policy", id: `Policy:${pid}`, tier: record.tier, contracts: Object.freeze([record]) as readonly [ContractRecord] });
}

// ---------------------------------------------------------------------------
// event
// ---------------------------------------------------------------------------

function eventImpl(name: unknown, options: unknown): EventDecl {
  const construct = "event";
  const n = requirePascalName(construct, name);
  const opts = requireOptions(construct, n, options, "event");
  validateCommon(construct, n, opts);
  const payload = opts.payload;
  if (!isPlainObject(payload)) fail(construct, n, "payload", `required: a flat object of field → payload type, got ${describe(payload)}`);
  for (const field of Object.keys(payload)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(field)) fail(construct, n, `payload.${field}`, "payload field names must be identifiers");
    literalUnion(construct, n, `payload.${field}`, payload[field], PAYLOAD_TYPE_VALUES);
  }
  if (opts.external !== undefined && typeof opts.external !== "boolean") fail(construct, n, "external", `expected a boolean, got ${describe(opts.external)}`);
  const decl = {
    kind: "event" as const,
    name: n as PascalName,
    options: freezeOptions<EventOptions<PayloadShape>>(opts, ["payload", "tags"]),
    id: `Event:${n}` as EventId,
  };
  return attach(decl, { kind: "event", id: `Event:${n}`, external: opts.external === true });
}

// ---------------------------------------------------------------------------
// action / query (shared auth + mode validation)
// ---------------------------------------------------------------------------

function validateAuth(construct: string, id: string, opts: Opts): { public: boolean; policy: PolicyId | null } {
  const hasPolicy = opts.policy !== undefined;
  const hasPublic = opts.public !== undefined;
  if (hasPolicy && hasPublic) fail(construct, id, "policy", "exactly one of `policy` or `public: true` is required, not both");
  if (!hasPolicy && !hasPublic) fail(construct, id, "policy", "exactly one of `policy` or `public: true` is required (neither given)");
  if (hasPublic) {
    if (opts.public !== true) fail(construct, id, "public", `must be literally true (omit it and provide a policy instead), got ${describe(opts.public)}`);
    return { public: true, policy: null };
  }
  if (!isPolicyDecl(opts.policy)) fail(construct, id, "policy", `expected a policy() declaration, got ${describe(opts.policy)}`);
  return { public: false, policy: `Policy:${opts.policy.id}` };
}

function validateMode(construct: string, id: string, opts: Opts): { mode: ActionMode; route: RouteSpec | null } {
  const hasRun = opts.run !== undefined;
  const hasHandler = opts.handler !== undefined;
  if (hasRun && hasHandler) fail(construct, id, "handler", "`run` (declared mode) and `handler` (observe mode) are mutually exclusive");
  if (hasRun && typeof opts.run !== "function") fail(construct, id, "run", `expected a function, got ${describe(opts.run)}`);
  if (hasHandler && typeof opts.handler !== "function") fail(construct, id, "handler", `expected a function reference, got ${describe(opts.handler)}`);
  const route = opts.route === undefined ? null : validateRoute(construct, id, "route", opts.route);
  const mode: ActionMode = hasRun ? "declared" : "observe";
  if (mode === "observe" && route === null) {
    fail(construct, id, "route", "required in observe mode (no `run`): the adapter matches requests by route; add `run` for an internal declared-mode action");
  }
  if (!isZodSchema(opts.input)) fail(construct, id, "input", `required: a Zod schema, got ${describe(opts.input)}`);
  return { mode, route };
}

function validateTransaction(construct: string, id: string, value: unknown): TransactionOptions {
  if (typeof value === "boolean") return value;
  if (!isPlainObject(value)) fail(construct, id, "transaction", `expected true, false or { timeout?, maxWait? }, got ${describe(value)}`);
  const extra = Object.keys(value).filter((k) => k !== "timeout" && k !== "maxWait");
  if (extra.length > 0) fail(construct, id, "transaction", `unknown keys ${JSON.stringify(extra)} (allowed: timeout, maxWait)`);
  for (const key of ["timeout", "maxWait"] as const) {
    const v = value[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
      fail(construct, id, `transaction.${key}`, `expected a positive number of milliseconds, got ${describe(v)}`);
    }
  }
  return Object.freeze({ ...value }) as TransactionOptions;
}

function validateSubject(construct: string, id: string, value: unknown): SubjectMeta {
  if (!isPlainObject(value)) fail(construct, id, "subject", `expected { entity, where }, got ${describe(value)}`);
  const extra = Object.keys(value).filter((k) => k !== "entity" && k !== "where");
  if (extra.length > 0) fail(construct, id, "subject", `unknown keys ${JSON.stringify(extra)} (allowed: entity, where)`);
  let model: string;
  if (isEntityDecl(value.entity)) model = value.entity.name;
  else if (typeof value.entity === "string" && PASCAL_NAME_RE.test(value.entity)) model = value.entity;
  else fail(construct, id, "subject.entity", `expected an entity() declaration or a PascalCase entity name, got ${describe(value.entity)}`);
  const where = flattenWhere(construct, "subject.where", value.where);
  for (const found of collectRefs(where)) {
    if (found.root !== "input" && found.root !== "actor") {
      fail(construct, id, "subject.where", `reference ${JSON.stringify(found.ref)} is not allowed; the subject is selected from input and actor only`);
    }
  }
  return Object.freeze({ entity: `Entity:${model}` as EntityId, model, clientName: uncapitalize(model), where });
}

function actionImpl(id: unknown, options: unknown): AnyActionDecl {
  const construct = "action";
  const aid = requireDeclaredId(construct, id);
  const opts = requireOptions(construct, aid, options, "action");
  validateCommon(construct, aid, opts);
  const auth = validateAuth(construct, aid, opts);
  const { mode, route } = validateMode(construct, aid, opts);
  validateOutput(construct, aid, opts.output);
  if (mode === "observe" && opts.transaction !== undefined) {
    fail(construct, aid, "transaction", "not available in observe mode (Averri does not own the transaction); add `run` for declared mode");
  }
  const transaction: TransactionOptions = mode === "observe" ? false : opts.transaction === undefined ? true : validateTransaction(construct, aid, opts.transaction);
  if (opts.effects === undefined) fail(construct, aid, "effects", `required: an array of ${EFFECT_VALUES.map((v) => JSON.stringify(v)).join(" | ")} (use [] for none)`);
  const effects = validateEffects(construct, aid, "effects", opts.effects);
  const idempotency = opts.idempotency === undefined ? null : validateIdempotency(construct, aid, "idempotency", opts.idempotency);
  const subject = opts.subject === undefined ? null : validateSubject(construct, aid, opts.subject);
  const requires = opts.requires === undefined ? [] : lowerClauses(construct, aid, aid, "requires", opts.requires, { allowGuards: true, allowPredicates: true });
  const ensures = opts.ensures === undefined ? [] : lowerClauses(construct, aid, aid, "ensures", opts.ensures, { allowGuards: true, allowPredicates: true });
  const contracts = Object.freeze([...requires, ...ensures]);
  checkSubjectRefs(construct, aid, contracts, subject !== null);
  const decl = {
    kind: "action" as const,
    id: aid,
    mode,
    options: freezeOptions(opts, ["route", "subject", "requires", "ensures", "effects", "idempotency", "tags"]),
  };
  return attach(decl, {
    kind: "action",
    id: `Action:${aid}`,
    mode,
    public: auth.public,
    policy: auth.policy,
    route,
    subject,
    transaction,
    effects,
    idempotency,
    contracts,
  }) as unknown as AnyActionDecl;
}

function queryImpl(id: unknown, options: unknown): AnyQueryDecl {
  const construct = "query";
  const qid = requireDeclaredId(construct, id);
  if (isPlainObject(options)) {
    for (const key of ["requires", "ensures", "effects", "subject", "transaction", "idempotency"]) {
      if (key in options) fail(construct, qid, key, "queries carry only a policy (or public) and input/output/run; contracts and effects belong on actions");
    }
  }
  const opts = requireOptions(construct, qid, options, "query");
  validateCommon(construct, qid, opts);
  const auth = validateAuth(construct, qid, opts);
  const { mode, route } = validateMode(construct, qid, opts);
  validateOutput(construct, qid, opts.output);
  const decl = { kind: "query" as const, id: qid, mode, options: freezeOptions(opts, ["route", "tags"]) };
  return attach(decl, { kind: "query", id: `Query:${qid}`, mode, public: auth.public, policy: auth.policy, route }) as unknown as AnyQueryDecl;
}

// ---------------------------------------------------------------------------
// workflow
// ---------------------------------------------------------------------------

function validateRetry(construct: string, id: string, value: unknown): RetrySpec {
  if (!isPlainObject(value)) fail(construct, id, "retry", `expected { attempts, backoff? }, got ${describe(value)}`);
  const extra = Object.keys(value).filter((k) => k !== "attempts" && k !== "backoff");
  if (extra.length > 0) fail(construct, id, "retry", `unknown keys ${JSON.stringify(extra)} (allowed: attempts, backoff)`);
  if (typeof value.attempts !== "number" || !Number.isInteger(value.attempts) || value.attempts < 0) {
    fail(construct, id, "retry.attempts", `expected a non-negative integer, got ${describe(value.attempts)}`);
  }
  if (value.backoff !== undefined) literalUnion(construct, id, "retry.backoff", value.backoff, RETRY_BACKOFF_VALUES);
  return Object.freeze({ ...value }) as unknown as RetrySpec;
}

function workflowImpl(name: unknown, options: unknown): WorkflowDecl {
  const construct = "workflow";
  const n = requirePascalName(construct, name);
  const opts = requireOptions(construct, n, options, "workflow");
  validateCommon(construct, n, opts);
  if (!isEventDecl(opts.on)) fail(construct, n, "on", `required: an event() declaration, got ${describe(opts.on)}`);
  if (opts.runner === undefined) fail(construct, n, "runner", "required: the runner object from your durable-execution library");
  if ((typeof opts.runner !== "object" || opts.runner === null) && typeof opts.runner !== "function") {
    fail(construct, n, "runner", `expected an object or function, got ${describe(opts.runner)}`);
  }
  if (opts.engine !== undefined) literalUnion(construct, n, "engine", opts.engine, WORKFLOW_ENGINE_VALUES);
  const retry = opts.retry === undefined ? null : validateRetry(construct, n, opts.retry);
  const decl = { kind: "workflow" as const, name: n as PascalName, options: freezeOptions<WorkflowOptions>(opts, ["retry", "tags"]) };
  return attach(decl, {
    kind: "workflow",
    id: `Workflow:${n}`,
    on: opts.on.id as EventId,
    engine: (opts.engine as WorkflowEngine | undefined) ?? "custom",
    retry,
  });
}

// ---------------------------------------------------------------------------
// integration
// ---------------------------------------------------------------------------

function validateWebhook(construct: string, id: string, value: unknown): void {
  if (!isPlainObject(value)) fail(construct, id, "webhook", `expected { verify, scheme, secretEnv?, rawBody, route? }, got ${describe(value)}`);
  const allowed = ["verify", "scheme", "secretEnv", "rawBody", "route"];
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) fail(construct, id, "webhook", `unknown keys ${JSON.stringify(extra)} (allowed: ${allowed.join(", ")})`);
  if (typeof value.verify !== "string" || value.verify.length === 0) {
    fail(construct, id, "webhook.verify", `required: the signature header name (e.g. "stripe-signature"), got ${describe(value.verify)}`);
  }
  literalUnion(construct, id, "webhook.scheme", value.scheme, WEBHOOK_SCHEME_VALUES);
  if (value.secretEnv !== undefined && (typeof value.secretEnv !== "string" || value.secretEnv.length === 0)) {
    fail(construct, id, "webhook.secretEnv", `expected an environment variable name, got ${describe(value.secretEnv)}`);
  }
  if (value.scheme !== "custom" && value.secretEnv === undefined) {
    fail(construct, id, "webhook.secretEnv", `required when scheme is ${JSON.stringify(value.scheme)} (the generated tests sign bodies with it)`);
  }
  if (typeof value.rawBody !== "boolean") fail(construct, id, "webhook.rawBody", `required: a boolean, got ${describe(value.rawBody)}`);
  if (value.route !== undefined) validateRoute(construct, id, "webhook.route", value.route);
}

function integrationImpl(name: unknown, options: unknown = {}): IntegrationDecl {
  const construct = "integration";
  const n = requirePascalName(construct, name);
  const opts = requireOptions(construct, n, options, "integration");
  validateCommon(construct, n, opts);
  if (opts.client !== undefined && (typeof opts.client !== "object" || opts.client === null) && typeof opts.client !== "function") {
    fail(construct, n, "client", `expected the client object, got ${describe(opts.client)}`);
  }
  if (opts.webhook !== undefined) validateWebhook(construct, n, opts.webhook);
  if (opts.idempotency !== undefined) validateIdempotency(construct, n, "idempotency", opts.idempotency);
  if (opts.nonTransactional !== undefined && typeof opts.nonTransactional !== "boolean") {
    fail(construct, n, "nonTransactional", `expected a boolean, got ${describe(opts.nonTransactional)}`);
  }
  const effects = opts.effects === undefined ? Object.freeze(["network"] as const) : validateEffects(construct, n, "effects", opts.effects);
  const decl = {
    kind: "integration" as const,
    name: n as PascalName,
    options: freezeOptions<IntegrationOptions>(opts, ["webhook", "idempotency", "effects", "tags"]),
  };
  return attach(decl, {
    kind: "integration",
    id: `Integration:${n}`,
    nonTransactional: opts.nonTransactional !== false,
    effects,
    hasWebhook: opts.webhook !== undefined,
  });
}

// ---------------------------------------------------------------------------
// Exports (typed through DeclarationApi so the overloads are the single source of truth)
// ---------------------------------------------------------------------------

export const entity: DeclarationApi["entity"] = entityImpl as DeclarationApi["entity"];
export const policy: DeclarationApi["policy"] = policyImpl as DeclarationApi["policy"];
export const event: DeclarationApi["event"] = eventImpl as DeclarationApi["event"];
export const action: DeclarationApi["action"] = actionImpl as unknown as DeclarationApi["action"];
export const query: DeclarationApi["query"] = queryImpl as unknown as DeclarationApi["query"];
export const workflow: DeclarationApi["workflow"] = workflowImpl as DeclarationApi["workflow"];
export const integration: DeclarationApi["integration"] = integrationImpl as DeclarationApi["integration"];

/** The whole API as one frozen object (handy for passing into helpers typed `DeclarationApi`). */
export const declarationApi: DeclarationApi = Object.freeze({ entity, policy, action, query, event, workflow, integration, e, db });
