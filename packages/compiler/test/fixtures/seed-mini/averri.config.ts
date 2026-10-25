// @ts-nocheck — copied from examples/seed-app for @averri/compiler tests
/**
 * Averri project configuration (SPEC-DECLARATIONS §9). The compiler reads the static fields with
 * ts-morph; `@averri/contracts` imports it under Vitest for the actor fixtures and the emitter spy.
 *
 * Actor fixtures use the seed data set (`src/seed.ts`): run `npm run db:seed` (or the test harness)
 * and the bearer tokens below resolve through the app's own `auth` middleware.
 */
import { defineConfig } from "@averri/core";
import { events } from "./src/events.js";

export default defineConfig({
  sourceRoots: ["src"],
  prismaSchema: "prisma/schema.prisma",
  entryPoints: ["src/app.ts"],
  authMiddleware: ["auth", "requireUser", "requireActor", "requireOrgRole"],
  actors: {
    anonymous: { actor: null },
    owner: {
      actor: { id: "u_owner", type: "user", email: "owner@acme.test", orgId: "org_acme", role: "owner" },
      headers: { authorization: "Bearer usr_seed_owner" },
    },
    admin: {
      actor: { id: "u_admin", type: "user", email: "admin@acme.test", orgId: "org_acme", role: "admin" },
      headers: { authorization: "Bearer usr_seed_admin" },
    },
    member: {
      actor: { id: "u_member", type: "user", email: "member@acme.test", orgId: "org_acme", role: "member" },
      headers: { authorization: "Bearer usr_seed_member" },
    },
    otherOrgAdmin: {
      actor: { id: "u_other", type: "user", email: "other@globex.test", orgId: "org_globex", role: "owner" },
      headers: { authorization: "Bearer usr_seed_other" },
    },
    outsider: {
      actor: { id: "u_outsider", type: "user", email: "outsider@example.test", orgId: null, role: null },
      headers: { authorization: "Bearer usr_seed_outsider" },
    },
    apiKeyMember: {
      actor: { id: "key_acme_member", type: "apiKey", orgId: "org_acme", role: "member" },
      headers: { authorization: "Bearer sk_seed_acme_member" },
    },
  },
  emitter: {
    eventNamePrefix: "averri/",
    publish: (name, payload) => events.send({ name, data: payload }),
    spy: { target: events, method: "send" },
  },
  sampling: { ensures: 0, invariants: 0 },
  test: { databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" },
});
