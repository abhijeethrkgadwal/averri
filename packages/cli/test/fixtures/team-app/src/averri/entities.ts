// @ts-nocheck — fixture
import { e, entity } from "@averri/core";

export const Invitation = entity("Invitation", {
  intent: "One invitation per team and email; re-inviting resends.",
  invariant: {
    pendingHasNoAcceptedAt: e.or(e.ne("status", "pending"), e.isNull("acceptedAt")),
    seatsPositive: e.gte("seats", 1),
  },
  owner: "team-platform",
});

export const Membership = entity("Membership", {
  intent: "Who belongs to a team and with which role.",
  invariant: {
    roleIsKnown: e.in("role", ["owner", "admin", "member"]),
  },
});

export const Ghost = entity("Invitaton", {});
