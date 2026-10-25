import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  NODE_KINDS,
  assertNodeId,
  compareIds,
  contractId,
  entityId,
  exposureId,
  fieldId,
  fileNameToNodeId,
  generatedTestId,
  handWrittenTestId,
  isClauseName,
  isDeclaredId,
  isKind,
  isNodeId,
  isNodeKind,
  isPascalName,
  isRepoRelativePath,
  isReservedClause,
  kindOf,
  moduleId,
  nodeId,
  nodeIdToFileName,
  parseContractId,
  parseExposureId,
  parseFieldId,
  parseNodeId,
  parseTestId,
  qualifierOf,
  validateNodeId,
  GENERATED_TEST_SUITES,
} from "../src/index.js";

const VALID_IDS = [
  "Entity:Invitation",
  "Field:Invitation.status",
  "Action:Team.inviteMember",
  "Query:Team.listMembers",
  "Policy:Team.OwnerOrAdmin",
  "Contract:Team.inviteMember.requires.notAlreadyMember",
  "Contract:Invitation.invariant.pendingHasNoAcceptedAt",
  "Contract:Team.OwnerOrAdmin.allow",
  "Event:MemberInvited",
  "Workflow:InviteFlow",
  "Integration:Stripe",
  "Exposure:hono:src/routes/teams.ts:41:4",
  "Exposure:express:src/app.ts:1:0",
  "Test:gen/Team.inviteMember.auth-matrix",
  "Test:gen/Stripe.pitfall.webhook-signature",
  "Test:tests/members.test.ts:17",
  "Module:src/members/inviteMember.ts",
] as const;

describe("nodeId / parseNodeId", () => {
  it("builds and parses every kind", () => {
    for (const kind of NODE_KINDS) {
      const id = nodeId(kind, "x.y");
      expect(id).toBe(`${kind}:x.y`);
      expect(parseNodeId(id)).toEqual({ kind, qualifier: "x.y" });
      expect(kindOf(id)).toBe(kind);
      expect(qualifierOf(id)).toBe("x.y");
      expect(isKind(id, kind)).toBe(true);
    }
  });
  it("rejects empty qualifiers and unknown kinds", () => {
    expect(() => nodeId("Entity", "")).toThrow(/empty qualifier/);
    expect(() => nodeId("Nope" as never, "x")).toThrow(/unknown node kind/);
    expect(parseNodeId("Nope:x")).toBeNull();
    expect(parseNodeId("Entity:")).toBeNull();
    expect(parseNodeId("Entity")).toBeNull();
    expect(parseNodeId(":x")).toBeNull();
    expect(isNodeId("Entity:X")).toBe(true);
    expect(isNodeId("entity:X")).toBe(false);
    expect(isNodeId(42)).toBe(false);
    expect(() => kindOf("bogus" as never)).toThrow(/malformed/);
    expect(() => qualifierOf("bogus" as never)).toThrow(/malformed/);
    expect(isNodeKind("Entity")).toBe(true);
    expect(isNodeKind("entity")).toBe(false);
  });
  it("keeps colons inside the qualifier (Exposure, Test)", () => {
    expect(parseNodeId("Exposure:hono:src/a.ts:1:2")).toEqual({ kind: "Exposure", qualifier: "hono:src/a.ts:1:2" });
  });
});

describe("validateNodeId", () => {
  it("accepts the spec examples", () => {
    for (const id of VALID_IDS) {
      const v = validateNodeId(id);
      expect(v.problems, id).toEqual([]);
      expect(v.ok).toBe(true);
      expect(() => assertNodeId(id)).not.toThrow();
    }
  });
  it.each([
    ["Entity:invitation", /PascalCase/],
    ["Entity:Invitation.status", /PascalCase/],
    ["Field:Invitation", /<Entity>\.<field>/],
    ["Field:Invitation.a.b", /<Entity>\.<field>/],
    ["Field:invitation.status", /PascalCase/],
    ["Action:inviteMember", /exactly one dot/],
    ["Action:team.inviteMember", /capitalised/],
    ["Action:Team.invite.Member", /exactly one dot/],
    ["Query:Team", /exactly one dot/],
    ["Policy:Team.", /exactly one dot/],
    ["Contract:Team.inviteMember.because.x", /must be <owner>/],
    ["Contract:Team.inviteMember.requires", /must be <owner>/],
    ["Contract:inviteMember.requires.x", /declared id/],
    ["Contract:team.OwnerOrAdmin.allow", /declared id/],
    ["Contract:invitation.invariant.x", /PascalCase entity/],
    ["Contract:Team.inviteMember.requires.not-ok", /identifier/],
    ["Event:memberInvited", /PascalCase/],
    ["Workflow:invite flow", /PascalCase/],
    ["Integration:stripe", /PascalCase/],
    ["Exposure:koa:src/a.ts:1:0", /<hono\|express>/],
    ["Exposure:hono:src/a.ts:0:0", /<hono\|express>/],
    ["Exposure:hono:src/a.ts:1", /<hono\|express>/],
    ["Exposure:hono:src/a.ts:1:x", /<hono\|express>/],
    ["Exposure:hono:/abs/a.ts:1:0", /repo-relative/],
    ["Exposure:hono:src\\a.ts:1:0", /repo-relative/],
    ["Test:gen/Team.inviteMember.unknown-suite", /gen\/<owner>/],
    ["Test:gen/.auth-matrix", /gen\/<owner>/],
    ["Test:tests/a.test.ts", /gen\/<owner>/],
    ["Test:tests/a.test.ts:0", /gen\/<owner>/],
    ["Test:./tests/a.test.ts:3", /repo-relative/],
    ["Module:./src/a.ts", /repo-relative/],
    ["Module:/src/a.ts", /repo-relative/],
    ["Module:src/../a.ts", /repo-relative/],
    ["Module:src/", /repo-relative/],
    ["Module:C:/src/a.ts", /repo-relative/],
    ["Nope:x", /unknown kind/],
    ["Entity:", /empty qualifier/],
    ["nothing", /not of the form/],
  ])("rejects %s", (id, re) => {
    const v = validateNodeId(id);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toMatch(re);
    expect(() => assertNodeId(id)).toThrow();
  });
  it("allows reserved $ clauses syntactically and flags them separately", () => {
    expect(validateNodeId("Contract:Team.inviteMember.requires.$subject").ok).toBe(true);
    expect(isReservedClause("$subject")).toBe(true);
    expect(isReservedClause("subject")).toBe(false);
    expect(isClauseName("$subject")).toBe(true);
    expect(isClauseName("not ok")).toBe(false);
  });
});

describe("per-kind constructors and parsers", () => {
  it("entity/field", () => {
    expect(entityId("Invitation")).toBe("Entity:Invitation");
    expect(fieldId("Entity:Invitation", "status")).toBe("Field:Invitation.status");
    expect(fieldId("Invitation", "status")).toBe("Field:Invitation.status");
    expect(parseFieldId("Field:Invitation.status")).toEqual({ entity: "Entity:Invitation", model: "Invitation", field: "status" });
    expect(parseFieldId("Field:Invitation")).toBeNull();
    expect(parseFieldId("Field:Invitation.")).toBeNull();
    expect(parseFieldId("Entity:Invitation")).toBeNull();
  });
  it("contractId builds and parses every phase", () => {
    expect(contractId("Action:Team.inviteMember", "requires", "notAlreadyMember")).toBe("Contract:Team.inviteMember.requires.notAlreadyMember");
    expect(contractId("Team.inviteMember", "ensures", "pendingForEmail")).toBe("Contract:Team.inviteMember.ensures.pendingForEmail");
    expect(contractId("Entity:Invitation", "invariant", "x")).toBe("Contract:Invitation.invariant.x");
    expect(contractId("Policy:Team.OwnerOrAdmin", "allow", null)).toBe("Contract:Team.OwnerOrAdmin.allow");
    expect(contractId("Policy:Team.OwnerOrAdmin", "allow", "allow")).toBe("Contract:Team.OwnerOrAdmin.allow");
    expect(() => contractId("Policy:Team.OwnerOrAdmin", "allow", "x")).toThrow(/no clause/);
    expect(() => contractId("Action:Team.inviteMember", "requires", null)).toThrow(/clause name/);
    expect(() => contractId("Action:Team.inviteMember", "requires", "a.b")).toThrow(/must not contain/);
    expect(parseContractId("Contract:Team.inviteMember.requires.notAlreadyMember")).toEqual({ ownerQualifier: "Team.inviteMember", phase: "requires", clause: "notAlreadyMember" });
    expect(parseContractId("Contract:Team.OwnerOrAdmin.allow")).toEqual({ ownerQualifier: "Team.OwnerOrAdmin", phase: "allow", clause: "allow" });
    expect(parseContractId("Contract:Invitation.invariant.x")).toEqual({ ownerQualifier: "Invitation", phase: "invariant", clause: "x" });
    // a requires clause literally named "allow" is still a requires clause
    expect(parseContractId("Contract:Team.x.requires.allow")?.phase).toBe("requires");
    expect(parseContractId("Contract:.allow")).toBeNull();
    expect(parseContractId("Contract:Team.x.y")).toBeNull();
    expect(parseContractId("Action:Team.x")).toBeNull();
  });
  it("exposureId round-trips including files with colons", () => {
    const id = exposureId("hono", "src/routes/teams.ts", 41, 4);
    expect(id).toBe("Exposure:hono:src/routes/teams.ts:41:4");
    expect(parseExposureId(id)).toEqual({ router: "hono", file: "src/routes/teams.ts", line: 41, col: 4 });
    expect(parseExposureId("Exposure:express:src/odd:name.ts:7:0")).toEqual({ router: "express", file: "src/odd:name.ts", line: 7, col: 0 });
    expect(parseExposureId("Exposure:hono:src/a.ts:01:0")).toBeNull();
    expect(parseExposureId("Exposure:hono::1:0")).toBeNull();
    expect(parseExposureId("Exposure:hono:1:0")).toBeNull();
    expect(parseExposureId("Module:x")).toBeNull();
  });
  it("test ids", () => {
    expect(generatedTestId("Action:Team.inviteMember", "auth-matrix")).toBe("Test:gen/Team.inviteMember.auth-matrix");
    expect(generatedTestId("Stripe", "pitfall.webhook-signature")).toBe("Test:gen/Stripe.pitfall.webhook-signature");
    expect(handWrittenTestId("tests/members.test.ts", 17)).toBe("Test:tests/members.test.ts:17");
    expect(parseTestId("Test:gen/Team.inviteMember.auth-matrix")).toEqual({ generated: true, ownerQualifier: "Team.inviteMember", suite: "auth-matrix" });
    expect(parseTestId("Test:gen/Stripe.pitfall.raw-body")).toEqual({ generated: true, ownerQualifier: "Stripe", suite: "pitfall.raw-body" });
    expect(parseTestId("Test:tests/members.test.ts:17")).toEqual({ generated: false, file: "tests/members.test.ts", line: 17 });
    expect(parseTestId("Test:gen/Team.x.nope")).toBeNull();
    expect(parseTestId("Test:tests/a.ts")).toBeNull();
    expect(parseTestId("Entity:X")).toBeNull();
    for (const suite of GENERATED_TEST_SUITES) {
      expect(parseTestId(generatedTestId("Team.x", suite))).toEqual({ generated: true, ownerQualifier: "Team.x", suite });
    }
  });
  it("moduleId", () => {
    expect(moduleId("src/a.ts")).toBe("Module:src/a.ts");
  });
});

describe("grammar predicates", () => {
  it("isDeclaredId / isPascalName / isRepoRelativePath", () => {
    expect(isDeclaredId("Team.inviteMember")).toBe(true);
    expect(isDeclaredId("Team.invite.Member")).toBe(false);
    expect(isDeclaredId("team.inviteMember")).toBe(false);
    expect(isPascalName("OAuthToken")).toBe(true);
    expect(isPascalName("oAuthToken")).toBe(false);
    expect(isRepoRelativePath("src/a.ts")).toBe(true);
    expect(isRepoRelativePath("a.ts")).toBe(true);
    expect(isRepoRelativePath("")).toBe(false);
    expect(isRepoRelativePath("./a.ts")).toBe(false);
    expect(isRepoRelativePath("src//a.ts")).toBe(false);
    expect(isRepoRelativePath("src/./a.ts")).toBe(false);
  });
});

describe("file-safe encoding (D-24)", () => {
  it("encodes with encodeURIComponent and decodes back", () => {
    expect(nodeIdToFileName("Exposure:hono:src/routes/teams.ts:41:4")).toBe("Exposure%3Ahono%3Asrc%2Froutes%2Fteams.ts%3A41%3A4");
    expect(nodeIdToFileName("Exposure:hono:src/routes/teams.ts:41:4")).not.toMatch(/[:/\\]/);
    for (const id of VALID_IDS) {
      expect(fileNameToNodeId(nodeIdToFileName(id))).toBe(id);
      expect(fileNameToNodeId(`.averri/cards/${nodeIdToFileName(id)}.md`)).toBe(id);
      expect(fileNameToNodeId(`C:\\x\\${nodeIdToFileName(id)}.json`)).toBe(id);
    }
    expect(fileNameToNodeId("%E0%A4%A")).toBeNull();
    expect(fileNameToNodeId("notanid")).toBeNull();
  });
  it("round-trips arbitrary qualifiers", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NODE_KINDS), fc.string({ minLength: 1 }), (kind, q) => {
        const id = nodeId(kind, q);
        expect(fileNameToNodeId(nodeIdToFileName(id))).toBe(id);
        expect(parseNodeId(id)).toEqual({ kind, qualifier: q });
      }),
    );
  });
});

describe("compareIds", () => {
  it("is a total order consistent with < on strings", () => {
    expect(compareIds("a", "b")).toBeLessThan(0);
    expect(compareIds("b", "a")).toBeGreaterThan(0);
    expect(compareIds("a", "a")).toBe(0);
    expect(["Entity:B", "Action:A", "Entity:A"].sort(compareIds)).toEqual(["Action:A", "Entity:A", "Entity:B"]);
  });
});
