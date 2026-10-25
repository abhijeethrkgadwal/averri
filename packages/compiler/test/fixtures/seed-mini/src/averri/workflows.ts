// @ts-nocheck — copied from examples/seed-app for @averri/compiler tests
import { workflow } from "@averri/core";
import { inviteFlow } from "../workflows/inviteFlow.js";
import { MemberInvited } from "./events.js";

export const InviteFlow = workflow("InviteFlow", {
  intent: "Email the invitation link whenever a member is invited (or re-invited).",
  on: MemberInvited,
  runner: inviteFlow,
  engine: "custom",
  retry: { attempts: 3, backoff: "fixed" },
  owner: "team-platform",
});

export const workflows = [InviteFlow] as const;
