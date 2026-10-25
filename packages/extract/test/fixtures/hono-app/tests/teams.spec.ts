// @averri covers Action:Team.inviteMember
import { describe, expect, it } from "vitest";

describe("teams", () => {
  // @averri covers Policy:Team.OwnerOrAdmin, Entity:Invitation
  it("invites a member", () => {
    expect("Contract:Team.inviteMember.requires.notAlreadyMember").toBeTruthy();
  });

  it.skip("skipped one", () => {
    expect(1).toBe(1);
  });
});

it.each([1, 2])("dynamic %i", (n) => {
  expect(n).toBeGreaterThan(0);
});
