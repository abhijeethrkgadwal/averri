import { defineConfig } from "@averri/core";

export default defineConfig({
  sourceRoots: ["src"],
  prismaSchema: "prisma/schema.prisma",
  entryPoints: ["src/app.ts"],
  authMiddleware: ["auth"],
  actors: {
    anonymous: { actor: null },
    alice: { actor: { id: "alice" }, headers: { authorization: "Bearer alice" } },
    bob: { actor: { id: "bob" }, headers: { authorization: "Bearer bob" } },
  },
  test: { databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" },
});
