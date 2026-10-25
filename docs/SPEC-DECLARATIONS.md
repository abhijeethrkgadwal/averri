# SPEC-DECLARATIONS — The `@averri/core` declaration API

Status: normative for V0. Types: `packages/core/src/types.ts`. Implemented by `@averri/core` (constructors, builders, `defineConfig`) and `@averri/contracts` (runtime pipeline, adapters, observe wrapper). Lowered to IR by `@averri/compiler`. Decisions that deviate from the FINAL design document are logged in `SPEC-DECISIONS.md` (`D-n`).

## 1. Design rules

1. **Seven constructs plus two builders, one spelling each.** `entity`, `policy`, `action`, `query`, `event`, `workflow`, `integration`, and the two builders `e`, `db`. Tier-3 contracts are bare async functions (D-1). No aliases, no sugar, no string mini-DSLs. `averri fmt` checks the key order shown in §4 (A1005, check-only in V0).
2. **Every closed option is a literal union.** `effects`, `route.method`, `engine`, payload types, `retry.backoff`, `webhook.scheme`: tsc rejects a hallucinated value before the compiler runs. `policy | public` is exclusive-or by type; observe mode requires `route` by type.
3. **TypeScript is the host, not the analyzer, and the compiler never runs your code.** The compiler lowers declaration call expressions STATICALLY with ts-morph from the statically analysable subset in §4.1 (D-2). It never imports a user module (no Prisma connection, no Inngest or Stripe client is created at build time). tsc is a backstop.
4. **The project's own Prisma client is used in handlers.** Averri never wraps data access; it scans `tx.<model>.<op>` calls to verify effects (SPEC-IR §3.1).
5. **Nothing is generated into the application in V0.** Routes, schemas, migrations and idempotency tables stay where they are (D-11). Averri generates tests, OpenAPI and spec cards only.
6. **Observe mode is the default adoption path; declared mode is a strict superset.** An agent that learned observe mode relearns nothing.

## 2. Project types (augmentation)

```ts
// src/averri.d.ts — written by `averri init` when @prisma/client is detected
import type { PrismaClient, Prisma } from "@prisma/client";
declare module "@averri/core" {
  interface AverriTypes {
    Actor: { id: string; orgId: string; role: "owner" | "admin" | "member" };
    PrismaClient: PrismaClient;
    TransactionClient: Prisma.TransactionClient;
    ModelName: Uncapitalize<Prisma.ModelName>;
  }
}
```

Without augmentation `Actor` is `{ id: string; [k: string]: unknown }`, the clients are `Record<string, unknown>`, and `ModelName` is `string`. **The worked examples below assume this file exists**: `actor.orgId` is `unknown` without it.

## 3. Identifiers

- `action`, `query`, `policy`: `"<Scope>.<name>"`, Scope capitalised, exactly one dot (`DeclaredId`). The string is the durable identity (SPEC-IR §2).
- `entity`, `event`, `workflow`, `integration`: PascalCase name (`PascalName`). An entity's name MUST equal the Prisma model name (A1003); the client accessor is derived as `Uncapitalize(name)` and is not declared (D-15).
- Contract clause names are the object keys of `requires`/`ensures`/`invariant`; they MUST be camelCase identifiers, unique within the phase, and MUST NOT start with `$` (reserved for runtime-synthesised contracts such as `requires.$subject`; A1004).

## 4. Worked example (declared mode)

```ts
// src/members/inviteMember.ts
import { z } from "zod";
import { entity, policy, action, event, workflow, e, db } from "@averri/core";
import { inngest } from "../inngest";
import { sendInviteEmail } from "../email";
import { allowlist } from "../allowlist";

// Entity facts attached to the existing Prisma model (no schema changes). Name = model name.
export const Invitation = entity("Invitation", {
  owner: "team-platform",
  invariant: { pendingHasNoAcceptedAt: e.or(e.ne("status", "pending"), e.isNull("acceptedAt")) },
});

export const OwnerOrAdmin = policy("Team.OwnerOrAdmin", {
  intent: "Owners and admins manage membership; members cannot.",
  allow: db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"),
                                   role: { in: ["owner", "admin"] } }),
});

export const MemberInvited = event("MemberInvited", {
  payload: { invitationId: "string", teamId: "string", email: "string" },
});

export const InviteMember = action("Team.inviteMember", {
  intent: "An owner or admin invites a person by email. Re-inviting a pending email resends; inviting an existing member is an error.",
  route: { method: "POST", path: "/teams/:teamId/invitations" },   // must match an existing Hono route (A2101)
  input: z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) }),
  output: "Invitation",
  policy: OwnerOrAdmin,
  requires: {
    notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),
    emailDomainAllowed: async ({ input, actor }) =>                  // tier 3 (opaque guard): external allowlist
      allowlist.check(actor.orgId, input.email),                     // input/actor typed from `input` and AverriTypes
  },
  ensures: {
    pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
    eventEmitted: e.emitted(MemberInvited, 1),
  },
  effects: ["db:write", "event:emit"],
  transaction: true,
  run: async ({ input, actor, tx, emit }) => {                      // tx is the project's Prisma tx client
    const inv = await tx.invitation.upsert({
      where: { teamId_email: { teamId: input.teamId, email: input.email } },
      create: { teamId: input.teamId, email: input.email, role: input.role, invitedBy: actor.id, status: "pending" },
      update: { role: input.role, resentAt: new Date() },
    });
    emit(MemberInvited, { invitationId: inv.id, teamId: inv.teamId, email: inv.email });
    return inv;
  },
});

export const InviteFlow = workflow("InviteFlow", {
  on: MemberInvited,
  runner: inngest.createFunction({ id: "invite-flow" }, { event: "averri/MemberInvited" }, async ({ event, step }) => {
    await step.run("email", () => sendInviteEmail(event.data.email, event.data.invitationId));
    await step.waitForEvent("accepted", { event: "averri/InvitationAccepted", timeout: "7d" });
  }),
  retry: { attempts: 3 },
});
```

Canonical key order checked by `averri fmt` (A1005): `intent, route, input, output, policy | public, subject, requires, ensures, effects, idempotency, transaction, run | handler, owner, tags`. Clause order inside `requires`/`ensures` is left alone: evaluation order is tier 1, tier 2, then guards (SPEC-CONTRACTS §6), independent of source order.

From this the compiler derives (no application code generated): the IR nodes and edges in SPEC-IR §9; diagnostics A2101 if the route is missing; the generated Vitest suites in SPEC-CONTRACTS §9 (auth matrix over the configured actor fixtures; `notAlreadyMember` violation → 412 with the Contract id; a fast-check property for `pendingForEmail`; exactly one `MemberInvited`; `InviteFlow` consumer exists); an OpenAPI entry; a spec card. The guard is listed as opaque and gets no test.

### 4.1 Statically analysable subset

The compiler lowers a declaration from its call expression without evaluating anything. Option values MUST be built from:

- object literals, array literals, string/number/boolean/`null` literals and template literals without substitutions;
- call chains on `e`, `db` imported from `@averri/core` (`e.and(e.eq(...), ...)`, `db.none(...)`), including through a local `const` alias;
- identifier references to other declaration `const`s in the project (`OwnerOrAdmin`, `MemberInvited`, `Invitation`), resolved by symbol to their declaring call;
- `z.*` chains (`z.object({...})`, `.extend`, `.merge`, `.optional`, imported schemas): the compiler records a `SymbolRef` and derives field names and types from the TypeChecker type of `z.output<typeof schema>`;
- member/identifier references for `run`, `handler`, `runner`, `client` (recorded as `SymbolRef`s; bodies are scanned, never executed);
- arrow or function expressions for `run` and for tier-3 clauses (scanned, never executed).

Anything else (spread, computed keys, conditional expressions, calls to arbitrary functions, values imported from non-declaration modules, `as` casts that change the literal) is A1004 "Declaration option is not statically analysable" on the offending property, and the declaration is lowered with that property omitted. A9001 (tsc) is unrelated and remains the type backstop.

## 5. Constructs

### 5.1 `entity(name, options?)`

Attaches facts to an existing Prisma model. `name` MUST be a model in the schema facts (A1003). `invariant` clauses are tier 1 only (the type rejects predicates and guards); bare paths refer to the row. Evaluation: declared mode evaluates invariants on the reloaded subject row and on `result` when `output` is this entity (the Prisma transaction client cannot be hooked, so "after every write" is not promised); observe mode evaluates them on the before/after `findMany` diff of the model in the test database; both modes also get the generated `invariant` property test. There is no `model` option (D-15) and no `tenantKey` in V0: tenant scoping is an ordinary policy predicate (FINAL §11.4); A2107 is reserved for a Stage 2 check.

### 5.2 `policy(id, options)`

One `allow` clause over `input` and `actor` only. Evaluated in the `authorize` phase, after validation, before the transaction, with the plain client. An anonymous actor (`null`) never reaches the policy: non-public declarations answer `401 Unauthenticated` first. Denial → `403 Forbidden` with `contract: "Policy:<id>"`. A guard-tier policy is allowed but makes the auth matrix for its actions non-derivable (A2106 warning); those actions count under `health.opaqueGuards` and the spec card says "who may: opaque".

### 5.3 `action(id, options)`

A state-changing operation. Exactly one of `policy` or `public: true` (type-enforced). `route` is optional in declared mode (internal actions) and required in observe mode; when present it MUST match an Exposure (A2101). `effects` is required so the agent states what it believes; `effect-scan` verifies (A4002). Mode is decided by shape: `run` present → declared; otherwise observe.

**Declared mode** (`run`): the pipeline below is owned by `@averri/contracts` and is the single normative order (identical in SPEC-CONTRACTS §8 and core `ActionContext`):

```
validate (Zod)                → 400 ValidationFailed
authorize (plain client)      → 401 Unauthenticated (actor null, not public) · 403 Forbidden (policy denied; skipped when public)
[tx begin]                      when transaction !== false
  load subject (self) + include relations used by owned-list ops; snapshot old
  requires                    → 412 PreconditionFailed   (all evaluated: tier 1, tier 2, guards with the plain client; first failure reported)
  run(ctx)                    → 500 HandlerError on throw (tx rolled back)
  reload subject (self after)
  ensures + invariants        → 500 PostconditionFailed  (tx rolled back)
[tx commit]
emit buffered events            (after commit; failure is trace-only, response stays 2xx — D-12)
```

`transaction` defaults to `true` (Prisma interactive transaction with Prisma defaults: `timeout` 5 000 ms, `maxWait` 2 000 ms); `transaction: { timeout, maxWait }` passes those through; `transaction: false` runs on the plain client, and an `ensures` failure then returns 500 with `committed: true` in the body and the trace. `ctx.tx` is the transaction client (or the plain client when `transaction: false`); guards always get the plain client in `ctx.prisma`. `ctx.emit` buffers; `e.emitted` counts the buffer. In production `requires` and `authorize` are always on; `ensures` and invariants follow `config.sampling` (default: on in `NODE_ENV !== "production"`, off otherwise). Success is `200` unless the adapter's `status` says otherwise.

**Observe mode** (no `run`): see §6.

`subject` identifies the row behind `self`/`old`: `{ entity: Invitation, where: { id: e.input("invitationId") } }`. `where` MUST select ≤ 1 row; 0 rows makes `self.*` refs evaluate to `undefined` (comparisons false); > 1 row is a runtime `412 PreconditionFailed` with contract `Contract:<action>.requires.$subject` (the `$` prefix marks a synthetic clause).

`idempotency` is a **fact** in V0 (D-11): it produces the `pitfall.idempotency` duplicate-delivery test and suppresses A5002. There is no runtime dedupe, replay, storage or migration in V0; the dedupe primitive is Stage 2.

### 5.4 `query(id, options)`

A declared read. Has `policy | public`, `input`, `output`, and `run` (`ctx.db`, non-transactional) or observe mode (`route` required, `handler` optional). No `requires`, `ensures`, `effects`, `subject`, `transaction`. The compiler adds verified `reads` edges from the body and errors on any write (A4004). Exists so reports and lists are tracked without forcing them into the action shape.

### 5.5 `event(name, options)`

Flat payload with `PayloadType` values. `external: true` suppresses A4003. `emit(Event, payload)` is typed from the payload shape. The compiler verifies every `emit` target is declared (A4001). Workflow runners subscribe to the project's own event name; Averri does not provide an event bus. The bridge from `emit` to the project's emitter/queue is configured once in `averri.config.ts` (`emitter: { publish, spy, eventNamePrefix: "averri/" }`, §9); `eventNamePrefix` is a plain string so `consumer-scan` can match `createFunction(_, { event: "averri/MemberInvited" })` statically.

### 5.6 `workflow(name, options)`

Binds `on: Event` to a `runner` object from Inngest, pg-boss or custom code. Averri never executes runners; it resolves `runner` to a `SymbolRef`, adds `consumedBy` edges, infers `engine` from the runner's import, scans `step.run("name")` literals, and generates the consumer-exists test. `retry` is recorded as a fact and compared with the runner's own configuration when the engine exposes it.

### 5.7 `integration(name, options)`

Declares a foreign client and its pitfalls. `webhook: { verify, scheme, secretEnv?, rawBody, route? }`: `scheme` (`"stripe" | "hmac-sha256" | "custom"`) and `secretEnv` tell the test generator how to sign bodies; `rawBody: true` adds the `pitfall.raw-body` test and A5001 (warning, no fix). `idempotency` generates the duplicate-delivery test and suppresses A5002. `nonTransactional` (default `true`) makes `effect-scan` report A4005 when the client is called inside a Averri-owned transaction.

### 5.8 Tier-3 clauses (guards)

A bare async function in `requires`, `ensures` or `allow`. Semantics in SPEC-CONTRACTS §6.

### 5.9 `e` and `db`

Builders; semantics in SPEC-CONTRACTS §4–5.

## 6. Observe mode

Same declaration, no `run`, `route` required, `handler` optional, no `transaction`:

```ts
export const InviteMember = action("Team.inviteMember", {
  intent: "An owner or admin invites a person by email. Re-inviting a pending email resends; inviting an existing member is an error.",
  route: { method: "POST", path: "/teams/:teamId/invitations" },
  input: z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) }),
  output: "Invitation",
  policy: OwnerOrAdmin,
  requires: {
    notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),
  },
  ensures: {
    pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
    eventEmitted: e.emitted(MemberInvited, 1),
  },
  effects: ["db:write", "event:emit"],
  // handler: inviteMemberHandler,   // optional: only feeds effect-scan; most handlers are inline and have no symbol
});
```

What observe mode does (normative detail in SPEC-CONTRACTS §8):

- Under Vitest only, through `observe(app, { declarations, config })` from `@averri/contracts`. It wraps at the fetch boundary (`app.fetch(req)` for Hono; `http.createServer(app)` on an ephemeral port for Express) and matches requests against declared routes with Averri's own matcher. It never registers middleware and never calls `handler`.
- For a matching request: parses `input` (`{ ...body|query, ...params }`) with the declared Zod schema; reads the subject row and the rows of entities with invariants (test database); evaluates `requires`; lets the real handler run; re-reads; evaluates `ensures` with `result` = parsed response body (only when status is 2xx), `emitted` from the spy on `config.emitter.spy`.
- Records an `ActionTrace` per request (with the Vitest test file and title); feeds generated tests and `explain`.
- Records the handler's own `401`/`403` as the policy decision (`observed: true`) and evaluates the declared policy AST against the fixture actor so the auth-matrix test can compare them.
- Without `handler`, `effect-scan` has nothing to scan: `effects.verified.complete` is `false` and A4002 is reported as `info`.

What observe mode does not do:

- Run in production or in the dev server. Nothing is in the request path.
- Own a transaction, provide idempotency storage, publish events, or change a response. A failing contract fails the test; the app is untouched.
- Generate tests for guards.

Moving to declared mode is: add `run`, optionally add `transaction`/`subject`, and route the Exposure's handler to `toHono(InviteMember, { actor: (c) => c.get("user") ?? null })` (or `toExpress(InviteMember, { actor: (req) => req.user ?? null })`) from `@averri/contracts`. The adapters build `input` as `{ ...(GET ? query : body), ...params }` (path params win, D-20), default to status 200, and serialise `Date` → ISO string and `Decimal`/`BigInt` → string. The A2101 fix recognises a `toHono(<Decl>, …)`/`toExpress(<Decl>, …)` argument as the Exposure's handler. Ids, contracts, tests and spec cards are unchanged.

## 7. Spec card (human projection)

`averri docs` renders every Action/Query to ≤ 15 lines:

```
## Team.inviteMember — POST /teams/:teamId/invitations
Intent: An owner or admin invites a person by email. Re-inviting a pending email resends; inviting an existing member is an error.
Who may: Team.OwnerOrAdmin — membership exists where teamId = input.teamId, userId = actor.id, role in [owner, admin]   [verified]
Requires:
  - notAlreadyMember: no membership where teamId = input.teamId, user.email = input.email   [verified]
  - emailDomainAllowed: opaque guard
Ensures:
  - pendingForEmail: result.email = input.email and result.status = "pending"   [verified]
  - eventEmitted: MemberInvited emitted exactly 1   [verified]
Effects: writes Invitation, reads Membership (policy, requires), emits MemberInvited → InviteFlow   (declared: db:write, event:emit — match)
Tests: auth-matrix (4), precondition (2), postcondition (1), event (1), consumer (1) — all generated, green
Owner: team-platform · Last change: a1f3c9 add-contract requires.emailDomainAllowed (2026-10-09)
```

Release gate on the reference app: a non-engineer reviews a PR from spec-card diffs alone.

## 8. `averri suggest`

Drafts observe-mode declarations for undeclared Exposures (SPEC-MCP §6.8): route and input from the extractor, policy from siblings, `requires` from `if (...) return 4xx` guards, `intent: "TODO"`. Output is a diff for a human to approve in a PR; never applied automatically.

## 9. Configuration (`averri.config.ts`)

```ts
import { defineConfig } from "@averri/core";
import { inngest } from "./src/inngest";

export default defineConfig({
  sourceRoots: ["src"],                                  // default
  prismaSchema: "prisma/schema.prisma",                  // default
  entryPoints: ["src/app.ts"],                           // files that build the Hono/Express app
  authMiddleware: ["auth", "requireUser"],               // middleware that establishes `actor` (A2103 for undeclared routes)
  publicMarker: "publicRoute",                           // middleware marking an intentionally public route (optional)
  actors: {                                              // fixtures; `anonymous` with actor: null is mandatory
    anonymous:      { actor: null },
    member:         { actor: { id: "u_member", orgId: "o1", role: "member" }, headers: { authorization: "Bearer member" } },
    otherTeamAdmin: { actor: { id: "u_other",  orgId: "o2", role: "admin"  }, headers: { authorization: "Bearer other"  } },
    admin:          { actor: { id: "u_admin",  orgId: "o1", role: "admin"  }, headers: { authorization: "Bearer admin"  } },
  },
  emitter: {
    eventNamePrefix: "averri/",
    publish: (name, payload) => inngest.send({ name: `averri/${name}`, data: payload }),   // declared mode
    spy: { target: inngest, method: "send" },                                               // observe mode
  },
  sampling: { ensures: 0, invariants: 0 },               // production only; default
  test: { databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" },   // default; the project supplies the test DB
});
```

The compiler lowers the static fields (`sourceRoots`, `prismaSchema`, `prismaClient`, `entryPoints`, `publicMarker`, `authMiddleware`, `emitter.eventNamePrefix`, fixture names, `test`) with ts-morph under the §4.1 rule and never imports the file; `@averri/contracts` imports it under Vitest and at runtime for `actors`, `emitter.publish` and `emitter.spy`. Fixture names are project-defined (D-19); the auth matrix iterates all of them.

## 10. Implementation notes

- **`@averri/core`**: constructors return frozen plain objects (`{ kind, id|name, mode?, options }`) plus, for `event`, the `id`. **No registry and no import-time side effects** (D-2). `e`/`db` build AST, normalise bare paths and flatten nested `where` objects. `defineConfig` fills defaults and freezes. Zero dependencies at runtime except `zod` as a peer.
- **`@averri/compiler`**: lowers declaration call expressions with ts-morph per §4.1: object-literal properties → node fields; identifier references → resolved by symbol to the declaring call or to a `SymbolRef`; `run`/`handler` bodies → `effect-scan`, `emit-scan`, handler line counts; Zod field names/types from the checker. It does not import `@averri/core` (ARCHITECTURE §2). Non-analysable values → A1004.
- **`@averri/contracts`**: `handle(decl)` returns `(input, actor) => Promise<HandleResult>`; `toHono(decl, options)` and `toExpress(decl, options)` are the adapters; `observe(app, options)` is the Vitest wrapper returning `{ request(fixture, req), close() }`. All record `ActionTrace`s to `.averri/traces/<date>.<pid>.jsonl`.
- Order of implementation: observe mode first (benchmark arm B), declared mode second (arm B+), external security review before declared mode is announced.
