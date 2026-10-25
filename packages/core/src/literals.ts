/**
 * Closed literal sets used for call-time validation, and the canonical key orders used by `averri fmt`.
 *
 * @averri/core imports TYPES ONLY from @averri/ir (ARCHITECTURE §2), so the value lists are restated here
 * and pinned to the IR unions with `satisfies` plus an exhaustiveness check: adding a member to the IR
 * union without updating this file fails `tsc`.
 */
import type { Effect, HttpMethod, PayloadType, RefRoot, WebhookScheme, WorkflowEngine, RetrySpec, ContractPhase } from "@averri/ir";

type Exhaustive<Union extends string, List extends readonly Union[]> = Exclude<Union, List[number]> extends never ? true : never;

export const EFFECT_VALUES = ["db:read", "db:write", "event:emit", "network"] as const satisfies readonly Effect[];
const _effects: Exhaustive<Effect, typeof EFFECT_VALUES> = true;

export const HTTP_METHOD_VALUES = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const satisfies readonly HttpMethod[];
const _methods: Exhaustive<HttpMethod, typeof HTTP_METHOD_VALUES> = true;

export const PAYLOAD_TYPE_VALUES = ["string", "number", "boolean", "date", "json"] as const satisfies readonly PayloadType[];
const _payloads: Exhaustive<PayloadType, typeof PAYLOAD_TYPE_VALUES> = true;

export const WEBHOOK_SCHEME_VALUES = ["stripe", "hmac-sha256", "custom"] as const satisfies readonly WebhookScheme[];
const _schemes: Exhaustive<WebhookScheme, typeof WEBHOOK_SCHEME_VALUES> = true;

export const WORKFLOW_ENGINE_VALUES = ["inngest", "pg-boss", "custom"] as const satisfies readonly WorkflowEngine[];
const _engines: Exhaustive<WorkflowEngine, typeof WORKFLOW_ENGINE_VALUES> = true;

type Backoff = NonNullable<RetrySpec["backoff"]>;
export const RETRY_BACKOFF_VALUES = ["fixed", "exponential"] as const satisfies readonly Backoff[];
const _backoffs: Exhaustive<Backoff, typeof RETRY_BACKOFF_VALUES> = true;

export const REF_ROOT_VALUES = ["input", "result", "actor", "self", "old"] as const satisfies readonly RefRoot[];
const _roots: Exhaustive<RefRoot, typeof REF_ROOT_VALUES> = true;

/** Operator keys of a `where` operator form (`{ in }`, `{ not }`, `{ lt }`, ...). A field with one of these names is unaddressable (A3002). */
export const WHERE_OPERATOR_KEYS = ["in", "not", "lt", "lte", "gt", "gte"] as const;
export type WhereOperatorKey = (typeof WHERE_OPERATOR_KEYS)[number];

void _effects, _methods, _payloads, _schemes, _engines, _backoffs, _roots;

/**
 * Reference roots allowed per contract phase (SPEC-CONTRACTS §2). `self`/`old` additionally require the
 * action to declare `subject`; `e.emitted` is allowed in `ensures` only.
 */
export const PHASE_ROOTS: Readonly<Record<ContractPhase, readonly RefRoot[]>> = Object.freeze({
  requires: Object.freeze(["input", "actor", "self"] as const),
  ensures: Object.freeze(["input", "actor", "self", "old", "result"] as const),
  invariant: Object.freeze(["self"] as const),
  allow: Object.freeze(["input", "actor"] as const),
});

/**
 * Canonical key order for `action()`/`query()` options, checked by `averri fmt` (A1005; SPEC-DECLARATIONS §4).
 * `policy` and `public` share one slot (exactly one is present); `run` and `handler` likewise.
 * Clause order inside `requires`/`ensures` is never checked.
 */
export const CANONICAL_KEY_ORDER = [
  "intent",
  "route",
  "input",
  "output",
  "policy",
  "public",
  "subject",
  "requires",
  "ensures",
  "effects",
  "idempotency",
  "transaction",
  "run",
  "handler",
  "owner",
  "tags",
] as const;

/**
 * Canonical key order per construct. The `action`/`query` entries are normative (SPEC-DECLARATIONS §4); the
 * others follow the same convention (`intent` first, `owner`/`tags` last, options in the order the spec
 * lists them; SPEC-DECISIONS D-35). Keys missing from a declaration are simply skipped by `fmt`.
 */
export const CANONICAL_KEY_ORDERS = Object.freeze({
  entity: Object.freeze(["intent", "invariant", "owner", "tags"] as const),
  policy: Object.freeze(["intent", "allow", "owner", "tags"] as const),
  event: Object.freeze(["intent", "payload", "external", "owner", "tags"] as const),
  action: CANONICAL_KEY_ORDER,
  query: Object.freeze(["intent", "route", "input", "output", "policy", "public", "run", "handler", "owner", "tags"] as const),
  workflow: Object.freeze(["intent", "on", "runner", "engine", "retry", "owner", "tags"] as const),
  integration: Object.freeze(["intent", "client", "webhook", "idempotency", "nonTransactional", "effects", "owner", "tags"] as const),
});
export type DeclarationKind = keyof typeof CANONICAL_KEY_ORDERS;

/** Identifier grammar shared by ids, clause names and path segments. */
export const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
/** `<Scope>.<name>`: Scope capitalised, exactly one dot (SPEC-DECLARATIONS §3). */
export const DECLARED_ID_RE = /^[A-Z][A-Za-z0-9_]*\.[A-Za-z_][\w]*$/;
/** PascalCase name for entity/event/workflow/integration. */
export const PASCAL_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/;
/** Contract clause names: camelCase identifiers; `$` is reserved for synthetic clauses (A1004). */
export const CLAUSE_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
