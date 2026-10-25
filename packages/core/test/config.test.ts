/**
 * `defineConfig` (SPEC-DECLARATIONS §9): defaults, validation, freezing; plus the exported constants
 * (`PHASES`, `PHASE_FAILURE`, `AUTHENTICATION_FAILURE`, `SUCCESS_STATUS`, canonical key orders, literal lists).
 */
import { describe, expect, it } from "vitest";
import { EFFECTS, HTTP_METHODS, PAYLOAD_TYPES, WEBHOOK_SCHEMES, REF_ROOTS } from "@averri/ir";
import {
  AUTHENTICATION_FAILURE,
  AverriDeclarationError,
  CANONICAL_KEY_ORDER,
  CANONICAL_KEY_ORDERS,
  CONFIG_DEFAULTS,
  EFFECT_VALUES,
  HTTP_METHOD_VALUES,
  PAYLOAD_TYPE_VALUES,
  PHASES,
  PHASE_FAILURE,
  PHASE_ROOTS,
  REF_ROOT_VALUES,
  SUCCESS_STATUS,
  WEBHOOK_SCHEME_VALUES,
  WORKFLOW_ENGINE_VALUES,
  RETRY_BACKOFF_VALUES,
  defineConfig,
} from "../src/index.js";

const inngest = { send: async () => undefined };
const minimal = { entryPoints: ["src/app.ts"], actors: { anonymous: { actor: null } } };

function expectRejection(fn: () => unknown, pattern: RegExp, option?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AverriDeclarationError);
  expect((caught as Error).message).toMatch(pattern);
  if (option !== undefined) expect((caught as AverriDeclarationError).option).toBe(option);
}

describe("defineConfig()", () => {
  it("fills every documented default and freezes the result", () => {
    const config = defineConfig(minimal);
    expect(config).toEqual({
      sourceRoots: ["src"],
      prismaSchema: "prisma/schema.prisma",
      prismaClient: null,
      entryPoints: ["src/app.ts"],
      actors: { anonymous: { actor: null } },
      emitter: null,
      publicMarker: null,
      authMiddleware: [],
      sampling: { ensures: 0, invariants: 0 },
      test: { databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" },
    });
    for (const part of [config, config.sourceRoots, config.entryPoints, config.actors, config.actors.anonymous, config.authMiddleware, config.sampling, config.test]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
    expect(CONFIG_DEFAULTS.prismaSchema).toBe("prisma/schema.prisma");
    expect(Object.isFrozen(CONFIG_DEFAULTS)).toBe(true);
  });

  it("passes the full worked example through and keeps function-valued fields", () => {
    const publish = (name: string, payload: Record<string, unknown>) => inngest.send();
    const config = defineConfig({
      sourceRoots: ["src", "lib"],
      prismaSchema: "db/schema.prisma",
      prismaClient: { file: "src/db.ts", symbol: "prisma" },
      entryPoints: ["src/app.ts"],
      authMiddleware: ["auth", "requireUser"],
      publicMarker: "publicRoute",
      actors: {
        anonymous: { actor: null },
        member: { actor: { id: "u_member", orgId: "o1", role: "member" }, headers: { authorization: "Bearer member" } },
        admin: { actor: { id: "u_admin", orgId: "o1", role: "admin" }, headers: { authorization: "Bearer admin" } },
      },
      emitter: { eventNamePrefix: "averri/", publish, spy: { target: inngest, method: "send" } },
      sampling: { ensures: 0.5 },
      test: { generatedDir: "tests/generated" },
    });
    expect(config.sourceRoots).toEqual(["src", "lib"]);
    expect(config.prismaClient).toEqual({ file: "src/db.ts", symbol: "prisma" });
    expect(config.actors.member).toEqual({ actor: { id: "u_member", orgId: "o1", role: "member" }, headers: { authorization: "Bearer member" } });
    expect(Object.isFrozen(config.actors.member!.actor)).toBe(true);
    expect(config.emitter!.publish).toBe(publish);
    expect(config.emitter!.spy.target).toBe(inngest);
    expect(Object.isFrozen(inngest)).toBe(false);
    expect(config.sampling).toEqual({ ensures: 0.5, invariants: 0 });
    expect(config.test).toEqual({ databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/generated" });
    expect(config.publicMarker).toBe("publicRoute");
  });

  it("rejects unknown keys and missing required fields", () => {
    expectRejection(() => defineConfig(null as never), /expected a configuration object/);
    expectRejection(() => defineConfig({ ...minimal, srcRoots: [] } as never), /unknown option \(allowed: sourceRoots, prismaSchema/, "srcRoots");
    expectRejection(() => defineConfig({ actors: minimal.actors } as never), /required: the files that build/, "entryPoints");
    expectRejection(() => defineConfig({ entryPoints: [] } as never), /required: actor fixtures/, "actors");
    expectRejection(() => defineConfig({ ...minimal, entryPoints: "src/app.ts" } as never), /array of non-empty strings/, "entryPoints");
    expectRejection(() => defineConfig({ ...minimal, sourceRoots: [""] }), /array of non-empty strings/, "sourceRoots");
    expectRejection(() => defineConfig({ ...minimal, prismaSchema: "" }), /non-empty string/, "prismaSchema");
    expectRejection(() => defineConfig({ ...minimal, prismaClient: { file: "x" } } as never), /non-empty string/, "prismaClient.symbol");
    expectRejection(() => defineConfig({ ...minimal, prismaClient: { file: "x", symbol: "y", extra: 1 } } as never), /unknown option/, "prismaClient.extra");
    expectRejection(() => defineConfig({ ...minimal, publicMarker: "" }), /non-empty string/, "publicMarker");
    expectRejection(() => defineConfig({ ...minimal, authMiddleware: [1] } as never), /array of non-empty strings/, "authMiddleware");
  });

  it("rejects malformed actor fixtures and requires anonymous", () => {
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: {} } as never), /required: the fixture `anonymous: \{ actor: null \}`/, "actors.anonymous");
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: { anonymous: { actor: { id: "x" } } } } as never), /must be null/, "actors.anonymous.actor");
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: { anonymous: {} } } as never), /required: an actor object or null/, "actors.anonymous.actor");
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: { anonymous: { actor: null }, m: { actor: "u1" } } } as never), /expected an object or null/, "actors.m.actor");
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: { anonymous: { actor: null }, m: { actor: { role: "x" } } } } as never), /non-empty string/, "actors.m.actor.id");
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: { anonymous: { actor: null }, m: { actor: { id: "u" }, headers: { a: 1 } } } } as never), /record of header strings/, "actors.m.headers");
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: { anonymous: { actor: null }, m: { actor: { id: "u" }, token: "t" } } } as never), /unknown option/, "actors.m.token");
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: { anonymous: null } } as never), /expected \{ actor, headers\? \}/, "actors.anonymous");
    expectRejection(() => defineConfig({ entryPoints: ["a"], actors: [] } as never), /record of actor fixtures/, "actors");
  });

  it("rejects malformed emitter, sampling and test blocks", () => {
    const ok = { eventNamePrefix: "averri/", publish: () => undefined, spy: { target: inngest, method: "send" } };
    expectRejection(() => defineConfig({ ...minimal, emitter: { ...ok, publish: "send" } } as never), /required: a function/, "emitter.publish");
    expectRejection(() => defineConfig({ ...minimal, emitter: { ...ok, spy: { target: inngest } } } as never), /non-empty string/, "emitter.spy.method");
    expectRejection(() => defineConfig({ ...minimal, emitter: { ...ok, spy: { target: "inngest", method: "send" } } } as never), /emitter client object/, "emitter.spy.target");
    expectRejection(() => defineConfig({ ...minimal, emitter: { ...ok, spy: { target: inngest, method: "send", extra: 1 } } } as never), /unknown option/, "emitter.spy.extra");
    expectRejection(() => defineConfig({ ...minimal, emitter: { ...ok, spy: undefined } } as never), /required: \{ target, method \}/, "emitter.spy");
    expectRejection(() => defineConfig({ ...minimal, emitter: { publish: ok.publish, spy: ok.spy } } as never), /required: a string such as "averri\/"/, "emitter.eventNamePrefix");
    expectRejection(() => defineConfig({ ...minimal, emitter: { ...ok, prefix: "x" } } as never), /unknown option/, "emitter.prefix");
    expectRejection(() => defineConfig({ ...minimal, emitter: "inngest" } as never), /expected \{ publish, spy, eventNamePrefix \}/, "emitter");
    expectRejection(() => defineConfig({ ...minimal, sampling: { ensures: 2 } }), /between 0 and 1/, "sampling.ensures");
    expectRejection(() => defineConfig({ ...minimal, sampling: { invariants: -0.1 } }), /between 0 and 1/, "sampling.invariants");
    expectRejection(() => defineConfig({ ...minimal, sampling: { requires: 1 } } as never), /unknown option/, "sampling.requires");
    expectRejection(() => defineConfig({ ...minimal, sampling: 1 } as never), /expected \{ ensures\?, invariants\? \}/, "sampling");
    expectRejection(() => defineConfig({ ...minimal, test: { databaseUrlEnv: "" } }), /non-empty string/, "test.databaseUrlEnv");
    expectRejection(() => defineConfig({ ...minimal, test: { generatedDir: 1 } } as never), /non-empty string/, "test.generatedDir");
    expectRejection(() => defineConfig({ ...minimal, test: { db: "pglite" } } as never), /unknown option/, "test.db");
  });
});

describe("runtime constants", () => {
  it("PHASES, PHASE_FAILURE, AUTHENTICATION_FAILURE, SUCCESS_STATUS match SPEC-CONTRACTS §8", () => {
    expect(PHASES).toEqual(["validate", "authorize", "requires", "run", "ensures", "emit"]);
    expect(PHASE_FAILURE).toEqual({
      validate: { status: 400, error: "ValidationFailed" },
      authorize: { status: 403, error: "Forbidden" },
      requires: { status: 412, error: "PreconditionFailed" },
      run: { status: 500, error: "HandlerError" },
      ensures: { status: 500, error: "PostconditionFailed" },
      emit: { status: null, error: "EmitFailed" },
    });
    expect(AUTHENTICATION_FAILURE).toEqual({ status: 401, error: "Unauthenticated" });
    expect(SUCCESS_STATUS).toBe(200);
    expect(Object.keys(PHASE_FAILURE)).toEqual([...PHASES]);
  });

  it("canonical key order matches SPEC-DECLARATIONS §4", () => {
    expect(CANONICAL_KEY_ORDER).toEqual([
      "intent", "route", "input", "output", "policy", "public", "subject", "requires", "ensures", "effects", "idempotency", "transaction", "run", "handler", "owner", "tags",
    ]);
    expect(CANONICAL_KEY_ORDERS.action).toBe(CANONICAL_KEY_ORDER);
    expect(Object.keys(CANONICAL_KEY_ORDERS).sort()).toEqual(["action", "entity", "event", "integration", "policy", "query", "workflow"]);
    for (const order of Object.values(CANONICAL_KEY_ORDERS)) {
      expect(order[0]).toBe("intent");
      expect(order.slice(-2)).toEqual(["owner", "tags"]);
      expect(new Set(order).size).toBe(order.length);
    }
  });

  it("literal lists stay in sync with @averri/ir", () => {
    expect([...EFFECT_VALUES]).toEqual([...EFFECTS]);
    expect([...HTTP_METHOD_VALUES]).toEqual([...HTTP_METHODS]);
    expect([...PAYLOAD_TYPE_VALUES]).toEqual([...PAYLOAD_TYPES]);
    expect([...WEBHOOK_SCHEME_VALUES]).toEqual([...WEBHOOK_SCHEMES]);
    expect([...REF_ROOT_VALUES]).toEqual([...REF_ROOTS]);
    expect(WORKFLOW_ENGINE_VALUES).toEqual(["inngest", "pg-boss", "custom"]);
    expect(RETRY_BACKOFF_VALUES).toEqual(["fixed", "exponential"]);
    expect(PHASE_ROOTS).toEqual({ requires: ["input", "actor", "self"], ensures: ["input", "actor", "self", "old", "result"], invariant: ["self"], allow: ["input", "actor"] });
  });
});
