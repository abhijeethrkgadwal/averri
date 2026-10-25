// @ts-nocheck — fixture project for @averri/compiler tests (never type-checked as part of the monorepo).
import { defineConfig } from "@averri/core";
import { bus } from "./src/bus.js";

export default defineConfig({
  sourceRoots: ["src"],
  prismaSchema: "prisma/schema.prisma",
  entryPoints: ["src/app.ts"],
  authMiddleware: ["auth"],
  actors: {
    anonymous: { actor: null },
    owner: { actor: { id: "u_owner", role: "owner" }, headers: { authorization: "Bearer owner" } },
    member: { actor: { id: "u_member", role: "member" }, headers: { authorization: "Bearer member" } },
  },
  emitter: {
    eventNamePrefix: "averri/",
    publish: (name, payload) => bus.send({ name, data: payload }),
    spy: { target: bus, method: "send" },
  },
  test: { databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" },
});
