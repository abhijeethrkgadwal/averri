import { describe, expect, it } from "vitest";

import { affectedBy, computeDependsOn, dependenciesOf, dependentsOf, edgeKey, entityOfField, fieldsNamedByContract, type ContractNode, type Edge } from "../src/index.js";
import { clone, edge, exampleGraph, extracted } from "./fixtures.js";

function keys(edges: Edge[]): string[] {
  return edges.map((e) => `${e.from}->${e.to}${e.attrs?.via ? ` via ${(e.attrs.via as string[]).join(",")}` : ""}`);
}

describe("computeDependsOn (propagation table)", () => {
  const g = exampleGraph();
  const deps = computeDependsOn(g);
  const direct = deps.filter((e) => !e.attrs?.via);
  const viaEdges = deps.filter((e) => e.attrs?.via);

  it("only emits dependsOn edges, deduplicated and sorted", () => {
    expect(deps.every((e) => e.kind === "dependsOn")).toBe(true);
    expect(new Set(deps.map(edgeKey)).size).toBe(deps.length);
    expect(deps.map(edgeKey)).toEqual(deps.map(edgeKey).slice().sort());
  });
  it("Entity: readers/writers/returners and the persistedBy module", () => {
    const toMembership = direct.filter((e) => e.to === "Entity:Membership").map((e) => e.from);
    expect(toMembership).toEqual(["Contract:Team.inviteMember.requires.notAlreadyMember", "Module:prisma/schema.prisma", "Policy:Team.OwnerOrAdmin", "Query:Team.listMembers"]);
    const toInvitation = direct.filter((e) => e.to === "Entity:Invitation").map((e) => e.from);
    expect(toInvitation).toEqual(["Action:Team.inviteMember", "Module:prisma/schema.prisma"]);
    // an Entity's Fields are not dependents of the Entity (the table does not say so)
    expect(toInvitation).not.toContain("Field:Invitation.status");
  });
  it("Field: contracts naming it through refs and where keys", () => {
    expect(direct.filter((e) => e.to === "Field:Membership.teamId").map((e) => e.from)).toEqual(["Contract:Team.OwnerOrAdmin.allow", "Contract:Team.inviteMember.requires.notAlreadyMember"]);
    expect(direct.filter((e) => e.to === "Field:Membership.user").map((e) => e.from)).toEqual(["Contract:Team.inviteMember.requires.notAlreadyMember"]);
    expect(direct.filter((e) => e.to === "Field:User.email").map((e) => e.from)).toEqual(["Contract:Team.inviteMember.requires.notAlreadyMember"]);
    // result.status resolves through output.entity; self.* through the invariant's entity
    expect(direct.filter((e) => e.to === "Field:Invitation.status").map((e) => e.from)).toEqual(["Contract:Invitation.invariant.pendingHasNoAcceptedAt", "Contract:Team.inviteMember.ensures.pendingForEmail"]);
    expect(direct.filter((e) => e.to === "Field:Invitation.acceptedAt").map((e) => e.from)).toEqual(["Contract:Invitation.invariant.pendingHasNoAcceptedAt"]);
    // input.* refs never resolve to Fields
    expect(direct.filter((e) => e.to === "Field:Invitation.email")).toHaveLength(0);
  });
  it("Policy -> authorized targets; Contract -> owner and covering tests; Event -> emitters and consumers", () => {
    expect(direct.filter((e) => e.to === "Policy:Team.OwnerOrAdmin").map((e) => e.from)).toEqual(["Action:Team.inviteMember", "Query:Team.listMembers"]);
    expect(direct.filter((e) => e.to === "Contract:Team.inviteMember.requires.notAlreadyMember").map((e) => e.from)).toEqual([
      "Action:Team.inviteMember",
      "Test:gen/Team.inviteMember.auth-matrix",
      "Test:tests/members.test.ts:17",
    ]);
    expect(direct.filter((e) => e.to === "Contract:Team.OwnerOrAdmin.allow").map((e) => e.from)).toEqual(["Policy:Team.OwnerOrAdmin"]);
    expect(direct.filter((e) => e.to === "Event:MemberInvited").map((e) => e.from)).toEqual(["Action:Team.inviteMember", "Workflow:InviteFlow"]);
  });
  it("Module -> contained nodes and validatesWith/implementedBy sources; Exposure <-> Action; Action -> tests", () => {
    expect(direct.filter((e) => e.to === "Module:src/members/inviteMember.ts").map((e) => e.from)).toEqual(["Action:Team.inviteMember", "Policy:Team.OwnerOrAdmin"]);
    expect(direct.filter((e) => e.to === "Module:src/routes/teams.ts").map((e) => e.from)).toEqual(["Exposure:hono:src/routes/teams.ts:41:4"]);
    // prisma-schema module is not a declaration/handler/route module: nothing depends on it directly
    expect(direct.filter((e) => e.to === "Module:prisma/schema.prisma")).toHaveLength(0);
    expect(direct.filter((e) => e.to === "Exposure:hono:src/routes/teams.ts:41:4").map((e) => e.from)).toEqual(["Action:Team.inviteMember"]);
    expect(direct.filter((e) => e.to === "Action:Team.inviteMember").map((e) => e.from)).toEqual(["Exposure:hono:src/routes/teams.ts:41:4", "Test:gen/Team.inviteMember.auth-matrix", "Test:tests/members.test.ts:17"]);
  });
  it("second step carries via and never overrides a direct edge", () => {
    // Field:Membership.teamId -> Contract -> Action: the Action is affected via the Contract
    const k = keys(viaEdges);
    expect(k).toContain("Action:Team.inviteMember->Field:Membership.teamId via Contract:Team.inviteMember.requires.notAlreadyMember");
    expect(k).toContain("Test:gen/Team.inviteMember.auth-matrix->Entity:Invitation via Action:Team.inviteMember");
    // Query -> Membership is direct; Membership -> Policy -> Query is a 2-step path too, but the direct edge wins (no via)
    const q = deps.find((e) => e.from === "Query:Team.listMembers" && e.to === "Entity:Membership")!;
    expect(q.attrs).toBeUndefined();
    // Test -> Contract (covers owner) -> Field is two steps; Test -> Action -> Contract -> Field would be three and is not emitted
    const testToField = deps.find((e) => e.from === "Test:gen/Team.inviteMember.auth-matrix" && e.to === "Field:Membership.teamId")!;
    expect(testToField.attrs!.via).toEqual(["Contract:Team.inviteMember.requires.notAlreadyMember"]); // the allow contract belongs to the Policy, which the test does not cover
    expect(deps.find((e) => e.from === "Test:gen/Team.inviteMember.auth-matrix" && e.to === "Field:User.email")!.attrs!.via).toEqual(["Contract:Team.inviteMember.requires.notAlreadyMember"]);
    expect(deps.find((e) => e.from === "Workflow:InviteFlow" && e.to === "Field:User.email")).toBeUndefined();
    for (const e of viaEdges) expect((e.attrs!.via as string[]).length).toBeGreaterThan(0);
  });
  it("merges multiple intermediates into a sorted via list", () => {
    const h = clone(exampleGraph());
    // Query also verified by the generated test: Test -> Query -> Membership and Test -> Action -> Invitation (distinct)
    h.edges.push(edge("verifiedBy", "Query:Team.listMembers", "Test:gen/Team.inviteMember.auth-matrix"));
    h.edges.push(edge("reads", "Action:Team.inviteMember", "Entity:Membership"));
    const d = computeDependsOn(h);
    const e = d.find((x) => x.from === "Test:gen/Team.inviteMember.auth-matrix" && x.to === "Entity:Membership")!;
    expect(e.attrs!.via).toEqual(["Action:Team.inviteMember", "Contract:Team.inviteMember.requires.notAlreadyMember", "Query:Team.listMembers"]);
  });
  it("provenance is the minimum of the underlying facts", () => {
    const writes = deps.find((e) => e.from === "Action:Team.inviteMember" && e.to === "Entity:Invitation")!;
    expect(writes.provenance.origin).toBe("verified");
    const persisted = deps.find((e) => e.from === "Module:prisma/schema.prisma" && e.to === "Entity:Invitation")!;
    expect(persisted.provenance.origin).toBe("extracted");
    const twoStep = deps.find((e) => e.from === "Test:gen/Team.inviteMember.auth-matrix" && e.to === "Entity:Invitation")!;
    expect(twoStep.provenance.origin).toBe("declared"); // verifiedBy (declared) + writes (verified)
  });
  it("ignores pre-existing dependsOn edges and dangling endpoints", () => {
    const h = clone(exampleGraph());
    h.edges.push(edge("dependsOn", "Entity:User", "Entity:Invitation"));
    h.edges.push(edge("reads", "Action:Team.inviteMember", "Entity:Ghost"));
    expect(keys(computeDependsOn(h))).toEqual(keys(deps));
  });
  it("is deterministic under edge order", () => {
    const h = clone(exampleGraph());
    h.edges.reverse();
    expect(computeDependsOn(h)).toEqual(deps);
  });
});

describe("dependents / affectedBy", () => {
  const g = exampleGraph();
  const withDeps = { ...g, edges: [...g.edges, ...computeDependsOn(g)] };
  it("dependentsOf / dependenciesOf", () => {
    expect(dependentsOf(withDeps, "Policy:Team.OwnerOrAdmin")).toEqual([
      "Action:Team.inviteMember",
      "Exposure:hono:src/routes/teams.ts:41:4",
      "Query:Team.listMembers",
      "Test:gen/Team.inviteMember.auth-matrix",
      "Test:tests/members.test.ts:17",
    ]);
    expect(dependenciesOf(withDeps, "Workflow:InviteFlow")).toEqual(["Event:MemberInvited"]);
    expect(dependenciesOf(withDeps, "Action:Team.inviteMember")).toContain("Policy:Team.OwnerOrAdmin");
    expect(dependentsOf(g, "Policy:Team.OwnerOrAdmin")).toEqual([]);
  });
  it("affectedBy returns the shortest why path and excludes changed nodes", () => {
    const affected = affectedBy(withDeps, ["Policy:Team.OwnerOrAdmin", "Action:Team.inviteMember"]);
    const ids = affected.map((a) => a.id);
    expect(ids).not.toContain("Action:Team.inviteMember");
    expect(affected.find((a) => a.id === "Query:Team.listMembers")!.why).toEqual(["Policy:Team.OwnerOrAdmin"]);
    expect(affected.find((a) => a.id === "Test:gen/Team.inviteMember.auth-matrix")!.why).toEqual(["Action:Team.inviteMember"]);
    expect(affectedBy(withDeps, [])).toEqual([]);
  });
});

describe("fieldsNamedByContract / entityOfField", () => {
  it("resolves refs and where keys through relations, ignoring unknown fields", () => {
    const g = exampleGraph();
    const c = g.nodes["Contract:Team.inviteMember.requires.notAlreadyMember"] as ContractNode;
    expect(fieldsNamedByContract(g, c)).toEqual(["Field:Membership.teamId", "Field:Membership.user", "Field:User.email"]);
    const guard = g.nodes["Contract:Team.inviteMember.requires.emailDomainAllowed"] as ContractNode;
    expect(fieldsNamedByContract(g, guard)).toEqual([]);
    const unknown: ContractNode = { ...c, expr: { op: "db.exists", model: "nothing", where: { x: { lit: 1 } } } };
    expect(fieldsNamedByContract(g, unknown)).toEqual([]);
    const selfOnAction: ContractNode = { ...c, expr: { op: "isNull", arg: { ref: "self.status" } } };
    expect(fieldsNamedByContract(g, selfOnAction)).toEqual([]); // action has no subject
    const withSubject = clone(g);
    (withSubject.nodes["Action:Team.inviteMember"] as { subject: unknown }).subject = { entity: "Entity:Invitation", where: {} };
    expect(fieldsNamedByContract(withSubject, selfOnAction)).toEqual(["Field:Invitation.status"]);
    expect(entityOfField("Field:Invitation.status")).toBe("Entity:Invitation");
    expect(entityOfField("Field:bad" as never)).toBeNull();
  });
  it("stops at a non-relation segment", () => {
    const g = exampleGraph();
    const c = g.nodes["Contract:Team.inviteMember.requires.notAlreadyMember"] as ContractNode;
    const deep: ContractNode = { ...c, expr: { op: "db.exists", model: "membership", where: { "teamId.nope": { lit: 1 } } }, provenance: extracted(0.5) };
    expect(fieldsNamedByContract(g, deep)).toEqual(["Field:Membership.teamId"]);
  });
});
