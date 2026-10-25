import { e, policy } from "@averri/core";

export const SignedIn = policy("Note.SignedIn", {
  intent: "Any signed-in user.",
  allow: e.ne("actor.id", ""),
});
