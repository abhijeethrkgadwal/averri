import { action, e, query } from "@averri/core";
import { z } from "zod";
import { SignedIn } from "./policies.js";

export const CreateNote = action("Note.create", {
  intent: "A signed-in user creates a note they own.",
  route: { method: "POST", path: "/notes" },
  input: z.object({ title: z.string().min(1) }),
  output: "Note",
  policy: SignedIn,
  ensures: {
    titleKept: e.eq("result.title", e.input("title")),
    ownedByCaller: e.eq("result.ownerId", e.actor("id")),
  },
  effects: ["db:write"],
});

export const ListNotes = query("Note.list", {
  intent: "A signed-in user lists their own notes.",
  route: { method: "GET", path: "/notes" },
  input: z.object({}),
  policy: SignedIn,
});
