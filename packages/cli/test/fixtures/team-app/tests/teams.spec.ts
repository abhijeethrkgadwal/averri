// @ts-nocheck — fixture hand-written test (named *.spec.ts so the monorepo's Vitest does not collect it)
// @averri covers Action:Team.inviteMember
import { describe, expect, it } from "vitest";

describe("teams", () => {
  it("invites a member", () => {
    expect("Policy:Team.OwnerOrAdmin").toContain("Policy");
  });
});
