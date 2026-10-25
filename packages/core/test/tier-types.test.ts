/**
 * Type-level contract of the declaration API (SPEC-CONTRACTS §1, §3; SPEC-DECLARATIONS §4, §6).
 * The assertions live in `typeAssertions`, which is type-checked by `tsc` (the root `typecheck`
 * script includes packages/* /test) and never called at runtime: @averri/core is types-only at this
 * stage, so there is nothing to import. The single `it` exists so Vitest reports the file.
 */
import { describe, expect, it } from "vitest";
import type { z as Zod } from "zod";
import type {
  ActionDecl,
  Actor,
  AnyActionDecl,
  Declaration,
  DeclarationApi,
  ExprClause,
  PolicyDecl,
  PredicateClause,
} from "../src/types.js";

export function typeAssertions(
  api: DeclarationApi,
  z: typeof Zod,
  allowlist: { check(orgId: unknown, email: string): Promise<boolean> },
  existingHandler: (c: unknown) => Promise<Response>,
): unknown[] {
  const { entity, policy, action, query, event, e, db } = api;

  // --- tier is visible in the type system ---------------------------------------------------------

  const exprOnly = e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending"));
  const withPredicate = e.and(exprOnly, db.exists("team", { id: e.input("teamId") }));
  const t1: ExprClause = exprOnly;
  const t2: PredicateClause = withPredicate;
  // @ts-expect-error an expression-only composite is not a predicate clause
  const t3: PredicateClause = exprOnly;
  // @ts-expect-error a predicate cannot be used where tier 1 is required (entity invariants)
  const inv = entity("Invitation", { invariant: { x: db.exists("team", {}) } });
  const okInv = entity("Invitation", { invariant: { pendingHasNoAcceptedAt: e.or(e.ne("status", "pending"), e.isNull("acceptedAt")) } });
  // @ts-expect-error `model` is derived from the name, not declared
  entity("Invitation", { model: "invitation" });

  // --- rhs strings are literals; ref-shaped literals are rejected --------------------------------

  const lit = e.eq("result.status", "pending");
  // @ts-expect-error looks like a reference; write e.result("email")
  e.eq("input.email", "result.email");
  // @ts-expect-error at least one clause
  e.and();
  // @ts-expect-error a guard (function) is not an analysable clause
  e.and(lit, async () => true);
  // @ts-expect-error `in` takes a literal list or a ref value, not an arbitrary value
  e.in("input.role", e.sum("self.lines", "amount"));
  const inOk = e.in("input.role", ["admin", "member"]);

  // --- worked example: guards get typed input/actor from the action's schema ---------------------

  const OwnerOrAdmin = policy("Team.OwnerOrAdmin", {
    allow: db.exists("membership", { teamId: e.input("teamId"), userId: e.actor("id"), role: { in: ["owner", "admin"] } }),
  });
  const MemberInvited = event("MemberInvited", { payload: { invitationId: "string", teamId: "string", email: "string" } });

  const InviteMember = action("Team.inviteMember", {
    intent: "An owner or admin invites a person by email.",
    route: { method: "POST", path: "/teams/:teamId/invitations" },
    input: z.object({ teamId: z.string(), email: z.string().email(), role: z.enum(["admin", "member"]) }),
    output: "Invitation",
    policy: OwnerOrAdmin,
    requires: {
      notAlreadyMember: db.none("membership", { teamId: e.input("teamId"), user: { email: e.input("email") } }),
      emailDomainAllowed: async ({ input, actor }) => allowlist.check(actor.orgId, input.email), // actor is non-null here
    },
    ensures: {
      pendingForEmail: e.and(e.eq("result.email", e.input("email")), e.eq("result.status", "pending")),
      eventEmitted: e.emitted(MemberInvited, 1),
      resultIsObject: ({ result }) => typeof result === "object" && result !== null, // result: unknown in guards
    },
    effects: ["db:write", "event:emit"],
    transaction: { timeout: 10_000 },
    run: async ({ input, actor, emit }) => {
      const inv = { id: "inv_1", teamId: input.teamId, email: input.email, invitedBy: actor.id, status: "pending" as const };
      emit(MemberInvited, { invitationId: inv.id, teamId: inv.teamId, email: inv.email });
      return inv;
    },
  });
  const declaredMode: "declared" = InviteMember.mode;
  type InviteOut = NonNullable<(typeof InviteMember)["__types"]>["output"];
  const outTyped: { id: string; status: "pending" } = null as unknown as InviteOut;

  // --- observe mode: route required, handler optional, actor nullable only when public ----------

  const Observe = action("Team.inviteMemberObserve", {
    route: { method: "POST", path: "/teams/:teamId/invitations" },
    input: z.object({ teamId: z.string() }),
    policy: OwnerOrAdmin,
    requires: { teamGiven: ({ input, actor }) => input.teamId.length > 0 && actor.id.length > 0 },
    effects: ["db:write"],
  });
  const observeMode: "observe" = Observe.mode;
  const WithHandler = action("Team.withHandler", {
    route: { method: "GET", path: "/health" },
    input: z.object({}),
    public: true,
    requires: { anon: ({ actor }) => actor === null || typeof actor.id === "string" },
    effects: [],
    handler: existingHandler,
  });
  // @ts-expect-error observe mode needs a route (no `run` and no `route`)
  action("Team.noRoute", { input: z.object({}), public: true, effects: [] });
  // @ts-expect-error exactly one of policy / public
  action("Team.both", { route: { method: "GET", path: "/x" }, input: z.object({}), public: true, policy: OwnerOrAdmin, effects: [] });
  // @ts-expect-error hallucinated option name
  action("Team.typo", { route: { method: "GET", path: "/x" }, input: z.object({}), public: true, effects: [], preconditions: {} });
  // @ts-expect-error hallucinated effect value
  action("Team.effect", { route: { method: "GET", path: "/x" }, input: z.object({}), public: true, effects: ["db:writes"] });
  // @ts-expect-error `transaction` is not available in observe mode
  action("Team.tx", { route: { method: "GET", path: "/x" }, input: z.object({}), public: true, effects: [], transaction: true });

  const ListMembers = query("Team.listMembers", {
    route: { method: "GET", path: "/teams/:teamId/members" },
    input: z.object({ teamId: z.string() }),
    policy: OwnerOrAdmin,
    run: async ({ input, actor }) => [{ teamId: input.teamId, by: actor.id }],
  });

  // --- decls are assignable to the erased forms ---------------------------------------------------

  const anyAction: AnyActionDecl = InviteMember;
  const decls: Declaration[] = [okInv, OwnerOrAdmin, MemberInvited, InviteMember, Observe, WithHandler, ListMembers];
  const p: PolicyDecl = OwnerOrAdmin;
  const a: ActionDecl = null as unknown as ActionDecl<"Team.x">;
  const actorShape: Actor = { id: "u1" };

  return [t1, t2, t3, inv, inOk, declaredMode, outTyped, observeMode, anyAction, decls, p, a, actorShape];
}

describe("@averri/core type contract", () => {
  it("is checked by tsc; the assertion function is never invoked at runtime", () => {
    expect(typeof typeAssertions).toBe("function");
  });
});
