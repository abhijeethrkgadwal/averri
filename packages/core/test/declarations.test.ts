/**
 * The seven constructors (SPEC-DECLARATIONS §5–6): frozen plain objects, the non-enumerable `__averri`
 * marker with lowered contract records, mode detection, and every call-time rejection.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BoolExprSchema } from "@averri/ir";
import {
  AVERRI_MARKER,
  AverriDeclarationError,
  action,
  averriMeta,
  db,
  declarationApi,
  declarationId,
  e,
  entity,
  event,
  integration,
  isDeclaration,
  policy,
  query,
  workflow,
  type Declaration,
} from "../src/index.js";

const Invitation = entity("Invitation", {
  owner: "team-platform",
  invariant: { pendingHasNoAcceptedAt: e.or(e.ne("status", "pending"), e.isNull("acceptedAt")) },
});
const OwnerOrAdmin = policy("Team.OwnerOrAdmin", {
  intent: "Owners and admins manage membership; members cannot.",
  allow: db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }),
});
const MemberInvited = event("MemberInvited", { payload: { invitationId: "string", teamId: "string", email: "string" } });
const input = z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) });
const route = { method: "POST", path: "/teams/:teamId/invitations" } as const;

function expectRejection(fn: () => unknown, pattern: RegExp, option?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AverriDeclarationError);
  expect((caught as Error).message).toMatch(pattern);
  if (option !== undefined) expect((caught as AverriDeclarationError).option).toBe(option);
}

describe("entity()", () => {
  it("returns a frozen plain object with a non-enumerable marker", () => {
    expect(Invitation).toEqual({
      kind: "entity",
      name: "Invitation",
      options: { owner: "team-platform", invariant: { pendingHasNoAcceptedAt: Invitation.options.invariant!.pendingHasNoAcceptedAt } },
    });
    expect(Object.keys(Invitation)).toEqual(["kind", "name", "options"]);
    expect(Object.isFrozen(Invitation) && Object.isFrozen(Invitation.options) && Object.isFrozen(Invitation.options.invariant)).toBe(true);
    expect(JSON.stringify(Invitation)).not.toContain(AVERRI_MARKER);
    expect(Object.prototype.hasOwnProperty.call(Invitation, AVERRI_MARKER)).toBe(true);
    expect(isDeclaration(Invitation)).toBe(true);
    expect(isDeclaration({ kind: "entity", name: "X", options: {} })).toBe(false);
  });

  it("lowers invariants to contract records", () => {
    const meta = averriMeta(Invitation);
    expect(meta.kind).toBe("entity");
    expect(meta.id).toBe("Entity:Invitation");
    expect(meta.model).toBe("Invitation");
    expect(meta.clientName).toBe("invitation");
    expect(meta.contracts).toEqual([
      {
        id: "Contract:Invitation.invariant.pendingHasNoAcceptedAt",
        phase: "invariant",
        clause: "pendingHasNoAcceptedAt",
        tier: "expr",
        expr: Invitation.options.invariant!.pendingHasNoAcceptedAt!.ast,
        guard: null,
        opaque: false,
      },
    ]);
    expect(declarationId(Invitation)).toBe("Entity:Invitation");
    expect(averriMeta(entity("OAuthToken")).clientName).toBe("oAuthToken");
    expect(entity("Plain")).toEqual({ kind: "entity", name: "Plain", options: {} });
  });

  it("rejects bad names, unknown options and non-tier-1 invariants", () => {
    expectRejection(() => entity("invitation" as never), /PascalCase/);
    expectRejection(() => entity("Team.Invitation"), /PascalCase/);
    expectRejection(() => entity(42 as never), /expected a name string/);
    expectRejection(() => entity("Invitation", { model: "invitation" } as never), /unknown option \(allowed: intent, invariant, owner, tags\)/, "model");
    expectRejection(() => entity("Invitation", { invariant: { x: db.exists("team", {}) } } as never), /expression-tier only/, "invariant.x");
    expectRejection(() => entity("Invitation", { invariant: { x: async () => true } } as never), /guards are not allowed in invariant/);
    expectRejection(() => entity("Invitation", { invariant: { x: e.eq("input.a", 1) } }), /not allowed in invariant \(allowed roots: self/);
    expectRejection(() => entity("Invitation", { invariant: { $x: e.eq("a", 1) } }), /reserved for synthetic contracts/);
    expectRejection(() => entity("Invitation", { invariant: { NotCamel: e.eq("a", 1) } }), /camelCase/);
    expectRejection(() => entity("Invitation", { invariant: { x: "nope" } } as never), /expected a clause/);
    expectRejection(() => entity("Invitation", { invariant: [] } as never), /expected an object of named clauses/);
    expectRejection(() => entity("Invitation", { intent: 1 } as never), /expected a string/, "intent");
    expectRejection(() => entity("Invitation", { tags: ["a", 1] } as never), /array of strings/, "tags");
    expectRejection(() => entity("Invitation", "x" as never), /expected an options object/);
  });
});

describe("policy()", () => {
  it("lowers allow to one contract record with the derived tier", () => {
    expect(OwnerOrAdmin.kind).toBe("policy");
    expect(OwnerOrAdmin.id).toBe("Team.OwnerOrAdmin");
    expect(Object.keys(OwnerOrAdmin)).toEqual(["kind", "id", "options"]);
    const meta = averriMeta(OwnerOrAdmin);
    expect(meta.id).toBe("Policy:Team.OwnerOrAdmin");
    expect(meta.tier).toBe("predicate");
    expect(meta.contracts[0]).toEqual({
      id: "Contract:Team.OwnerOrAdmin.allow",
      phase: "allow",
      clause: null,
      tier: "predicate",
      expr: (OwnerOrAdmin.options.allow as { ast: unknown }).ast,
      guard: null,
      opaque: false,
    });
    BoolExprSchema.parse(meta.contracts[0].expr);
    const guardFn = async () => true;
    const Guarded = policy("Team.Guarded", { allow: guardFn });
    const gm = averriMeta(Guarded);
    expect(gm.tier).toBe("guard");
    expect(gm.contracts[0]).toEqual({ id: "Contract:Team.Guarded.allow", phase: "allow", clause: null, tier: "guard", expr: null, guard: guardFn, opaque: true });
    expect(averriMeta(policy("Team.Simple", { allow: e.eq("actor.role", "admin") })).tier).toBe("expr");
  });

  it("rejects bad ids, missing allow and refs outside input/actor", () => {
    expectRejection(() => policy("ownerOrAdmin" as never, { allow: e.eq("actor.role", "admin") }), /"<Scope>.<name>"/);
    expectRejection(() => policy("Team.Sub.Deep" as never, { allow: e.eq("actor.role", "admin") }), /exactly one dot/);
    expectRejection(() => policy("Team.X", {} as never), /required/, "allow");
    expectRejection(() => policy("Team.X", { allow: "yes" } as never), /expected a clause/, "allow");
    expectRejection(() => policy("Team.X", { allow: e.eq("self.ownerId", e.actor("id")) }), /"self.ownerId" is not allowed in allow/);
    expectRejection(() => policy("Team.X", { allow: e.eq("result.a", 1) }), /not allowed in allow/);
    expectRejection(() => policy("Team.X", { allow: e.emitted(MemberInvited) }), /e\.emitted\(\) is only allowed in ensures/);
    expectRejection(() => policy("Team.X", { allow: e.eq("actor.role", "admin"), deny: 1 } as never), /unknown option/, "deny");
  });
});

describe("event()", () => {
  it("returns the declaration with its IR id", () => {
    expect(MemberInvited).toEqual({
      kind: "event",
      name: "MemberInvited",
      options: { payload: { invitationId: "string", teamId: "string", email: "string" } },
      id: "Event:MemberInvited",
    });
    expect(Object.isFrozen(MemberInvited.options.payload)).toBe(true);
    expect(averriMeta(MemberInvited)).toEqual({ kind: "event", id: "Event:MemberInvited", external: false });
    expect(averriMeta(event("Ext", { payload: { at: "date", meta: "json", n: "number", ok: "boolean" }, external: true })).external).toBe(true);
  });

  it("rejects bad payloads and unknown options", () => {
    expectRejection(() => event("X", {} as never), /required: a flat object/, "payload");
    expectRejection(() => event("X", { payload: { id: "uuid" } } as never), /expected one of "string" \| "number" \| "boolean" \| "date" \| "json", got the string "uuid"/, "payload.id");
    expectRejection(() => event("X", { payload: { "a-b": "string" } } as never), /identifiers/);
    expectRejection(() => event("X", { payload: {}, external: "yes" } as never), /boolean/, "external");
    expectRejection(() => event("X", { payload: {}, schema: 1 } as never), /unknown option/);
    expectRejection(() => event("lower" as never, { payload: {} }), /PascalCase/);
  });
});

describe("action() declared mode", () => {
  const guard = async () => true;
  const InviteMember = action("Team.inviteMember", {
    intent: "An owner or admin invites a person by email.",
    route,
    input,
    output: "Invitation",
    policy: OwnerOrAdmin,
    requires: {
      notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),
      emailDomainAllowed: guard,
    },
    ensures: {
      pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
      eventEmitted: e.emitted(MemberInvited, 1),
    },
    effects: ["db:write", "event:emit"],
    transaction: true,
    run: async ({ input, emit }) => {
      emit(MemberInvited, { invitationId: "inv_1", teamId: input.teamId, email: input.email });
      return { id: "inv_1", email: input.email, status: "pending" as const };
    },
  });

  it("is a frozen plain object with mode, options and the marker", () => {
    expect(InviteMember.kind).toBe("action");
    expect(InviteMember.id).toBe("Team.inviteMember");
    expect(InviteMember.mode).toBe("declared");
    expect(Object.keys(InviteMember)).toEqual(["kind", "id", "mode", "options"]);
    expect(Object.isFrozen(InviteMember) && Object.isFrozen(InviteMember.options) && Object.isFrozen(InviteMember.options.requires)).toBe(true);
    expect(InviteMember.options.policy).toBe(OwnerOrAdmin);
    expect(InviteMember.options.input).toBe(input);
    expect(typeof InviteMember.options.run).toBe("function");
    expect(Object.keys(InviteMember.options)).toEqual(["intent", "route", "input", "output", "policy", "requires", "ensures", "effects", "transaction", "run"]);
  });

  it("carries lowered contracts in requires-then-ensures source order", () => {
    const meta = averriMeta(InviteMember);
    expect(meta.kind).toBe("action");
    expect(meta.id).toBe("Action:Team.inviteMember");
    expect(meta.mode).toBe("declared");
    expect(meta.public).toBe(false);
    expect(meta.policy).toBe("Policy:Team.OwnerOrAdmin");
    expect(meta.route).toEqual(route);
    expect(meta.subject).toBeNull();
    expect(meta.transaction).toBe(true);
    expect(meta.effects).toEqual(["db:write", "event:emit"]);
    expect(meta.idempotency).toBeNull();
    expect(meta.contracts.map((c) => [c.id, c.tier, c.opaque])).toEqual([
      ["Contract:Team.inviteMember.requires.notAlreadyMember", "predicate", false],
      ["Contract:Team.inviteMember.requires.emailDomainAllowed", "guard", true],
      ["Contract:Team.inviteMember.ensures.pendingForEmail", "expr", false],
      ["Contract:Team.inviteMember.ensures.eventEmitted", "expr", false],
    ]);
    expect(meta.contracts[1]!.guard).toBe(guard);
    expect(meta.contracts[1]!.expr).toBeNull();
    expect(meta.contracts[0]!.expr).toEqual({
      op: "db.none",
      model: "membership",
      where: { teamId: { ref: "input.teamId" }, "user.email": { ref: "input.email" } },
    });
    for (const c of meta.contracts) if (c.expr) BoolExprSchema.parse(c.expr);
  });

  it("defaults transaction to true, passes options through, and lowers subject/idempotency", () => {
    const WithSubject = action("Invitation.accept", {
      input: z.object({ invitationId: z.string() }),
      public: true,
      subject: { entity: Invitation, where: { id: e.input("invitationId") } },
      requires: { stillPending: e.eq("status", "pending"), notMine: e.ne("self.invitedBy", e.actor("id")) },
      ensures: { accepted: e.and(e.eq("self.status", "accepted"), e.eq("old.status", "pending"), e.not(e.isNull("acceptedAt"))) },
      effects: ["db:write"],
      idempotency: { key: { header: "idempotency-key" }, ttlSeconds: 3600 },
      transaction: { timeout: 10_000 },
      run: async () => ({ ok: true }),
    });
    const meta = averriMeta(WithSubject);
    expect(meta.public).toBe(true);
    expect(meta.policy).toBeNull();
    expect(meta.route).toBeNull();
    expect(meta.transaction).toEqual({ timeout: 10_000 });
    expect(meta.subject).toEqual({ entity: "Entity:Invitation", model: "Invitation", clientName: "invitation", where: { id: { ref: "input.invitationId" } } });
    expect(meta.idempotency).toEqual({ key: { header: "idempotency-key" }, ttlSeconds: 3600 });
    expect(averriMeta(action("A.b", { input: z.object({}), public: true, effects: [], run: async () => null })).transaction).toBe(true);
    const NoTx = action("A.c", { input: z.object({}), public: true, effects: [], transaction: false, run: async () => null });
    expect(averriMeta(NoTx).transaction).toBe(false);
    const ByName = action("A.d", {
      input: z.object({ id: z.string() }),
      public: true,
      subject: { entity: "Invitation", where: { id: e.input("id"), team: { ownerId: e.actor("id") } } },
      effects: [],
      output: z.object({ id: z.string() }),
      run: async () => ({ id: "x" }),
    });
    expect(averriMeta(ByName).subject!.where).toEqual({ id: { ref: "input.id" }, "team.ownerId": { ref: "actor.id" } });
    expect(averriMeta(action("A.e", { input: z.object({}), public: true, effects: [], output: "void", run: async () => undefined })).id).toBe("Action:A.e");
  });

  it("accepts the whole worked example of SPEC-DECLARATIONS §4 (with observe + declared siblings)", () => {
    const decls: Declaration[] = [Invitation, OwnerOrAdmin, MemberInvited, InviteMember];
    expect(decls.every(isDeclaration)).toBe(true);
    expect(decls.map(declarationId)).toEqual(["Entity:Invitation", "Policy:Team.OwnerOrAdmin", "Event:MemberInvited", "Action:Team.inviteMember"]);
  });
});

describe("action() observe mode", () => {
  it("detects observe mode without run; handler is optional", () => {
    const Observe = action("Team.inviteMemberObserve", {
      route,
      input,
      policy: OwnerOrAdmin,
      requires: { notAlreadyMember: db.none("membership", { teamId: e.input("teamId") }) },
      ensures: { pendingForEmail: e.eq("result.status", "pending") },
      effects: ["db:write"],
    });
    expect(Observe.mode).toBe("observe");
    expect(Observe.options.run).toBeUndefined();
    const meta = averriMeta(Observe);
    expect(meta.mode).toBe("observe");
    expect(meta.transaction).toBe(false);
    expect(meta.contracts).toHaveLength(2);
    const handler = async () => new Response("ok");
    const WithHandler = action("Team.withHandler", { route: { method: "GET", path: "/health" }, input: z.object({}), public: true, effects: [], handler });
    expect(WithHandler.options.handler).toBe(handler);
    expect(averriMeta(WithHandler).mode).toBe("observe");
  });
});

describe("action() rejections", () => {
  const base = { route, input, effects: [] as const };

  it("ids and options object", () => {
    expectRejection(() => action("inviteMember" as never, { ...base, public: true }), /"<Scope>.<name>"/);
    expectRejection(() => action("Team.invite.member" as never, { ...base, public: true }), /exactly one dot/);
    expectRejection(() => action("Team.x", undefined as never), /expected an options object/);
    expectRejection(() => action("Team.x", { ...base, public: true, preconditions: {} } as never), /unknown option \(allowed: intent, route, input, output, policy, public, subject, requires, ensures, effects, idempotency, transaction, run, handler, owner, tags\)/, "preconditions");
  });

  it("policy XOR public", () => {
    expectRejection(() => action("Team.x", { ...base } as never), /exactly one of `policy` or `public: true` is required \(neither given\)/, "policy");
    expectRejection(() => action("Team.x", { ...base, public: true, policy: OwnerOrAdmin } as never), /not both/);
    expectRejection(() => action("Team.x", { ...base, public: false } as never), /must be literally true/, "public");
    expectRejection(() => action("Team.x", { ...base, public: "yes" } as never), /must be literally true/);
    expectRejection(() => action("Team.x", { ...base, policy: { id: "Team.X" } } as never), /expected a policy\(\) declaration/, "policy");
    expectRejection(() => action("Team.x", { ...base, policy: Invitation } as never), /expected a policy\(\) declaration/);
  });

  it("run XOR handler, observe needs route, transaction only in declared mode", () => {
    expectRejection(() => action("Team.x", { ...base, public: true, run: async () => null, handler: () => null } as never), /mutually exclusive/, "handler");
    expectRejection(() => action("Team.x", { ...base, public: true, run: "notAFunction" } as never), /expected a function/, "run");
    expectRejection(() => action("Team.x", { ...base, public: true, handler: {} } as never), /expected a function reference/, "handler");
    expectRejection(() => action("Team.x", { input, effects: [], public: true } as never), /required in observe mode/, "route");
    expectRejection(() => action("Team.x", { ...base, public: true, transaction: true } as never), /not available in observe mode/, "transaction");
    expectRejection(() => action("Team.x", { ...base, public: true, run: async () => null, transaction: "yes" } as never), /expected true, false or \{ timeout\?, maxWait\? \}/);
    expectRejection(() => action("Team.x", { ...base, public: true, run: async () => null, transaction: { timeout: -1 } }), /positive number of milliseconds/, "transaction.timeout");
    expectRejection(() => action("Team.x", { ...base, public: true, run: async () => null, transaction: { isolation: "x" } } as never), /unknown keys \["isolation"\]/);
  });

  it("route, input, output, effects, idempotency literal unions and shapes", () => {
    expectRejection(() => action("Team.x", { ...base, route: { method: "get", path: "/x" }, public: true } as never), /expected one of "GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE", got the string "get"/, "route.method");
    expectRejection(() => action("Team.x", { ...base, route: { method: "GET", path: "x" }, public: true } as never), /starting with "\/"/, "route.path");
    expectRejection(() => action("Team.x", { ...base, route: { method: "GET", path: "/x", name: "y" }, public: true } as never), /unknown keys \["name"\]/);
    expectRejection(() => action("Team.x", { ...base, route: "/x", public: true } as never), /expected \{ method, path \}/);
    expectRejection(() => action("Team.x", { ...base, input: { teamId: "string" }, public: true } as never), /required: a Zod schema/, "input");
    expectRejection(() => action("Team.x", { route, effects: [], public: true } as never), /required: a Zod schema/);
    expectRejection(() => action("Team.x", { ...base, public: true, output: "invitation" } as never), /PascalCase/, "output");
    expectRejection(() => action("Team.x", { ...base, public: true, output: 42 } as never), /expected an entity name/, "output");
    expectRejection(() => action("Team.x", { route, input, public: true } as never), /required: an array of "db:read" \| "db:write" \| "event:emit" \| "network"/, "effects");
    expectRejection(() => action("Team.x", { ...base, effects: ["db:writes"], public: true } as never), /got the string "db:writes"/, "effects[0]");
    expectRejection(() => action("Team.x", { ...base, effects: ["db:write", "db:write"], public: true } as never), /duplicate effect "db:write"/);
    expectRejection(() => action("Team.x", { ...base, effects: "db:write", public: true } as never), /expected an array of effects/);
    expectRejection(() => action("Team.x", { ...base, public: true, idempotency: { key: { header: "k" } } } as never), /positive number of seconds/, "idempotency.ttlSeconds");
    expectRejection(() => action("Team.x", { ...base, public: true, idempotency: { key: { header: "k", input: "i" }, ttlSeconds: 1 } } as never), /exactly one of \{ header: string \} or \{ input: string \}/);
    expectRejection(() => action("Team.x", { ...base, public: true, idempotency: { key: "k", ttlSeconds: 1 } } as never), /expected \{ header \} or \{ input \}/);
    expectRejection(() => action("Team.x", { ...base, public: true, idempotency: { key: { header: "k" }, ttlSeconds: 1, scope: "x" } } as never), /unknown keys \["scope"\]/);
  });

  it("contract clauses: names, tiers, phase roots, emitted placement", () => {
    expectRejection(() => action("Team.x", { ...base, public: true, requires: { $subject: e.eq("input.a", 1) } } as never), /reserved for synthetic contracts/, "requires.$subject");
    expectRejection(() => action("Team.x", { ...base, public: true, requires: { "not-camel": e.eq("input.a", 1) } } as never), /camelCase identifier/);
    expectRejection(() => action("Team.x", { ...base, public: true, requires: { x: { tier: "expr" } } } as never), /expected a clause built with e\.\*\/db\.\* or a bare async guard function/, "requires.x");
    expectRejection(() => action("Team.x", { ...base, public: true, requires: "x" } as never), /expected an object of named clauses/);
    expectRejection(() => action("Team.x", { ...base, public: true, requires: { r: e.eq("result.a", 1) } }), /"result.a" is not allowed in requires \(allowed roots: input, actor, self; A3003\)/, "requires.r");
    expectRejection(() => action("Team.x", { ...base, public: true, requires: { r: e.eq("old.a", 1) } }), /not allowed in requires/);
    expectRejection(() => action("Team.x", { ...base, public: true, requires: { r: e.emitted(MemberInvited) } }), /e\.emitted\(\) is only allowed in ensures/);
    expectRejection(() => action("Team.x", { ...base, public: true, requires: { r: db.exists("t", { id: e.result("id") }) } }), /"result.id" is not allowed in requires/);
    // ensures accepts every root given a subject; without subject self/old are rejected
    expectRejection(() => action("Team.x", { ...base, public: true, requires: { r: e.eq("status", "pending") } }), /"self.status" needs a `subject`/, "requires.r");
    expectRejection(() => action("Team.x", { ...base, public: true, ensures: { r: e.eq("old.status", "pending") } }), /"old.status" needs a `subject`/, "ensures.r");
    expectRejection(() => action("Team.x", { ...base, public: true, ensures: { r: db.exists("t", { id: e.self("id") }) } }), /"self.id" needs a `subject`/);
    // element scope: bare paths inside exists/count refer to the element and do not need a subject
    const ok = action("Team.ok", { ...base, public: true, ensures: { r: e.exists("result.lines", e.eq("kind", "tax")), c: e.gt(e.count("result.lines", e.gt("amount", 0)), 0) } });
    expect(averriMeta(ok).contracts).toHaveLength(2);
  });

  it("subject shape", () => {
    const declared = { input: z.object({ id: z.string() }), public: true as const, effects: [] as const, run: async () => null };
    expectRejection(() => action("Team.x", { ...declared, subject: { entity: "Invitation" } } as never), /expected a where object/, "subject.where");
    expectRejection(() => action("Team.x", { ...declared, subject: { entity: "invitation", where: {} } } as never), /expected an entity\(\) declaration or a PascalCase entity name/, "subject.entity");
    expectRejection(() => action("Team.x", { ...declared, subject: { entity: MemberInvited, where: {} } } as never), /subject.entity/);
    expectRejection(() => action("Team.x", { ...declared, subject: { entity: "Invitation", where: { id: e.self("id") } } }), /selected from input and actor only/, "subject.where");
    expectRejection(() => action("Team.x", { ...declared, subject: "Invitation" } as never), /expected \{ entity, where \}/);
    expectRejection(() => action("Team.x", { ...declared, subject: { entity: "Invitation", where: {}, include: [] } } as never), /unknown keys \["include"\]/);
  });
});

describe("query()", () => {
  it("declared and observe modes with the marker", () => {
    const ListMembers = query("Team.listMembers", {
      route: { method: "GET", path: "/teams/:teamId/members" },
      input: z.object({ teamId: z.string() }),
      policy: OwnerOrAdmin,
      run: async ({ input }) => [{ teamId: input.teamId }],
    });
    expect(ListMembers.kind).toBe("query");
    expect(ListMembers.mode).toBe("declared");
    expect(Object.keys(ListMembers)).toEqual(["kind", "id", "mode", "options"]);
    expect(averriMeta(ListMembers)).toEqual({
      kind: "query",
      id: "Query:Team.listMembers",
      mode: "declared",
      public: false,
      policy: "Policy:Team.OwnerOrAdmin",
      route: { method: "GET", path: "/teams/:teamId/members" },
    });
    const Observe = query("Team.health", { route: { method: "GET", path: "/health" }, input: z.object({}), public: true });
    expect(Observe.mode).toBe("observe");
    expect(averriMeta(Observe).public).toBe(true);
    const Internal = query("Team.internal", { input: z.object({}), public: true, output: Invitation, run: async () => 1 });
    expect(averriMeta(Internal).route).toBeNull();
  });

  it("rejects contracts/effects and the same auth/mode errors as action()", () => {
    const base = { route: { method: "GET", path: "/x" } as const, input: z.object({}) };
    expectRejection(() => query("Team.x", { ...base, public: true, requires: {} } as never), /queries carry only a policy/, "requires");
    expectRejection(() => query("Team.x", { ...base, public: true, effects: [] } as never), /queries carry only a policy/, "effects");
    expectRejection(() => query("Team.x", { ...base, public: true, transaction: true } as never), /queries carry only a policy/, "transaction");
    expectRejection(() => query("Team.x", { ...base, public: true, foo: 1 } as never), /unknown option \(allowed: intent, route, input, output, policy, public, run, handler, owner, tags\)/, "foo");
    expectRejection(() => query("Team.x", { ...base } as never), /exactly one of `policy` or `public: true`/);
    expectRejection(() => query("Team.x", { ...base, public: true, policy: OwnerOrAdmin } as never), /not both/);
    expectRejection(() => query("Team.x", { input: z.object({}), public: true } as never), /required in observe mode/, "route");
    expectRejection(() => query("Team.x", { ...base, public: true, run: async () => 1, handler: () => 1 } as never), /mutually exclusive/);
    expectRejection(() => query("Team.x", { ...base, input: {}, public: true } as never), /required: a Zod schema/, "input");
    expectRejection(() => query("Team.x", { ...base, public: true, output: "bad name" } as never), /output/);
  });
});

describe("workflow()", () => {
  const runner = { id: "invite-flow" };

  it("binds an event to a runner and records engine/retry in the marker", () => {
    const InviteFlow = workflow("InviteFlow", { on: MemberInvited, runner, retry: { attempts: 3 } });
    expect(InviteFlow).toEqual({ kind: "workflow", name: "InviteFlow", options: { on: MemberInvited, runner, retry: { attempts: 3 } } });
    expect(InviteFlow.options.runner).toBe(runner);
    expect(Object.isFrozen(InviteFlow.options.retry)).toBe(true);
    expect(averriMeta(InviteFlow)).toEqual({ kind: "workflow", id: "Workflow:InviteFlow", on: "Event:MemberInvited", engine: "custom", retry: { attempts: 3 } });
    const fnRunner = () => undefined;
    expect(averriMeta(workflow("Pg", { on: MemberInvited, runner: fnRunner as unknown as object, engine: "pg-boss" })).engine).toBe("pg-boss");
    expect(averriMeta(workflow("Pg2", { on: MemberInvited, runner, retry: { attempts: 0, backoff: "exponential" } })).retry).toEqual({ attempts: 0, backoff: "exponential" });
  });

  it("rejects missing/invalid on, runner, engine and retry", () => {
    expectRejection(() => workflow("X", { runner } as never), /required: an event\(\) declaration/, "on");
    expectRejection(() => workflow("X", { on: Invitation, runner } as never), /event\(\) declaration/);
    expectRejection(() => workflow("X", { on: MemberInvited } as never), /required: the runner object/, "runner");
    expectRejection(() => workflow("X", { on: MemberInvited, runner: "inngest" } as never), /expected an object or function/, "runner");
    expectRejection(() => workflow("X", { on: MemberInvited, runner, engine: "temporal" } as never), /expected one of "inngest" \| "pg-boss" \| "custom", got the string "temporal"/, "engine");
    expectRejection(() => workflow("X", { on: MemberInvited, runner, retry: { attempts: 1.5 } }), /non-negative integer/, "retry.attempts");
    expectRejection(() => workflow("X", { on: MemberInvited, runner, retry: { attempts: 1, backoff: "linear" } } as never), /expected one of "fixed" \| "exponential"/, "retry.backoff");
    expectRejection(() => workflow("X", { on: MemberInvited, runner, retry: { attempts: 1, delay: 5 } } as never), /unknown keys \["delay"\]/);
    expectRejection(() => workflow("X", { on: MemberInvited, runner, retry: 3 } as never), /expected \{ attempts, backoff\? \}/);
    expectRejection(() => workflow("X", { on: MemberInvited, runner, steps: [] } as never), /unknown option/, "steps");
    expectRejection(() => workflow("x" as never, { on: MemberInvited, runner }), /PascalCase/);
  });
});

describe("integration()", () => {
  const client = { charges: {} };

  it("declares a client with webhook facts and defaults in the marker", () => {
    const Stripe = integration("Stripe", {
      client,
      webhook: { verify: "stripe-signature", scheme: "stripe", secretEnv: "STRIPE_WEBHOOK_SECRET", rawBody: true, route: { method: "POST", path: "/webhooks/stripe" } },
      idempotency: { key: { header: "idempotency-key" }, ttlSeconds: 86_400 },
    });
    expect(Stripe.kind).toBe("integration");
    expect(Stripe.options.client).toBe(client);
    expect(Stripe.options.nonTransactional).toBeUndefined();
    expect(averriMeta(Stripe)).toEqual({ kind: "integration", id: "Integration:Stripe", nonTransactional: true, effects: ["network"], hasWebhook: true });
    const Custom = integration("Mailer", { nonTransactional: false, effects: ["network", "db:read"], webhook: { verify: "x-sig", scheme: "custom", rawBody: false } });
    expect(averriMeta(Custom)).toEqual({ kind: "integration", id: "Integration:Mailer", nonTransactional: false, effects: ["network", "db:read"], hasWebhook: true });
    expect(averriMeta(integration("Bare", {})).hasWebhook).toBe(false);
    expect(integration("Bare", {})).toEqual({ kind: "integration", name: "Bare", options: {} });
  });

  it("rejects malformed webhook, client, effects and options", () => {
    expectRejection(() => integration("S", { webhook: { verify: "h", scheme: "stripe", rawBody: true } }), /required when scheme is "stripe"/, "webhook.secretEnv");
    expectRejection(() => integration("S", { webhook: { verify: "h", scheme: "hmac-sha256", rawBody: true } }), /required when scheme is "hmac-sha256"/);
    expectRejection(() => integration("S", { webhook: { verify: "", scheme: "custom", rawBody: true } }), /signature header name/, "webhook.verify");
    expectRejection(() => integration("S", { webhook: { verify: "h", scheme: "jwt", rawBody: true } } as never), /expected one of "stripe" \| "hmac-sha256" \| "custom"/, "webhook.scheme");
    expectRejection(() => integration("S", { webhook: { verify: "h", scheme: "custom" } } as never), /required: a boolean/, "webhook.rawBody");
    expectRejection(() => integration("S", { webhook: { verify: "h", scheme: "custom", rawBody: true, secretEnv: "" } }), /environment variable name/, "webhook.secretEnv");
    expectRejection(() => integration("S", { webhook: { verify: "h", scheme: "custom", rawBody: true, route: { method: "POST", path: "hooks" } } }), /starting with "\/"/, "webhook.route.path");
    expectRejection(() => integration("S", { webhook: { verify: "h", scheme: "custom", rawBody: true, header: "x" } } as never), /unknown keys \["header"\]/);
    expectRejection(() => integration("S", { webhook: "stripe" } as never), /expected \{ verify, scheme/);
    expectRejection(() => integration("S", { client: "stripe" } as never), /expected the client object/, "client");
    expectRejection(() => integration("S", { effects: ["http"] } as never), /got the string "http"/, "effects[0]");
    expectRejection(() => integration("S", { nonTransactional: "no" } as never), /expected a boolean/, "nonTransactional");
    expectRejection(() => integration("S", { idempotency: { key: { input: "k" }, ttlSeconds: 0 } }), /positive number of seconds/);
    expectRejection(() => integration("S", { sdk: "stripe" } as never), /unknown option \(allowed: intent, client, webhook, idempotency, nonTransactional, effects, owner, tags\)/, "sdk");
  });
});

describe("marker helpers and the API object", () => {
  it("averriMeta throws for foreign objects; the marker is immutable", () => {
    expectRejection(() => averriMeta({ kind: "entity", name: "X", options: {} } as never), /expected a declaration produced by @averri\/core/);
    const desc = Object.getOwnPropertyDescriptor(Invitation, AVERRI_MARKER)!;
    expect(desc.enumerable).toBe(false);
    expect(desc.writable).toBe(false);
    expect(desc.configurable).toBe(false);
    expect(Object.isFrozen(desc.value)).toBe(true);
    expect("toJSON" in Invitation).toBe(false);
  });

  it("declarationApi exposes the nine members, frozen", () => {
    expect(Object.keys(declarationApi).sort()).toEqual(["action", "db", "e", "entity", "event", "integration", "policy", "query", "workflow"]);
    expect(Object.isFrozen(declarationApi)).toBe(true);
    expect(declarationApi.e).toBe(e);
    expect(declarationApi.action).toBe(action);
  });
});
