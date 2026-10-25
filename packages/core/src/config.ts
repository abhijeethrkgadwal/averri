/**
 * `defineConfig` for `averri.config.ts` (SPEC-DECLARATIONS §9): fills documented defaults, validates the
 * closed shape and freezes the result. The compiler reads the static fields with ts-morph and never
 * imports the file; `@averri/contracts` imports it for `actors`, `emitter.publish` and `emitter.spy`.
 */
import type { ActorFixture, AverriConfig, AverriConfigInput, DefineConfig, EmitterConfig } from "./types.js";
import { AverriDeclarationError, describe, isPlainObject } from "./errors.js";

const CONSTRUCT = "defineConfig";

/** Defaults applied by {@link defineConfig}. Exported so tools can show "default" next to a value. */
export const CONFIG_DEFAULTS = Object.freeze({
  sourceRoots: Object.freeze(["src"]) as readonly string[],
  prismaSchema: "prisma/schema.prisma",
  prismaClient: null,
  emitter: null,
  publicMarker: null,
  authMiddleware: Object.freeze([]) as readonly string[],
  sampling: Object.freeze<AverriConfig["sampling"]>({ ensures: 0, invariants: 0 }),
  test: Object.freeze<AverriConfig["test"]>({ databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" }),
});

const INPUT_KEYS = [
  "sourceRoots",
  "prismaSchema",
  "prismaClient",
  "entryPoints",
  "actors",
  "emitter",
  "publicMarker",
  "authMiddleware",
  "sampling",
  "test",
] as const;

function fail(option: string | null, detail: string): never {
  throw new AverriDeclarationError(CONSTRUCT, null, option, detail);
}

function stringArray(option: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length === 0)) {
    fail(option, `expected an array of non-empty strings, got ${describe(value)}`);
  }
  return [...(value as string[])];
}

function nonEmptyString(option: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail(option, `expected a non-empty string, got ${describe(value)}`);
  return value;
}

function knownKeys(option: string | null, value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) fail(option === null ? extra[0] ?? null : `${option}.${extra[0]}`, `unknown option (allowed: ${allowed.join(", ")})`);
}

function validateActors(value: unknown): AverriConfig["actors"] {
  if (!isPlainObject(value)) fail("actors", `expected a record of actor fixtures, got ${describe(value)}`);
  const out: Record<string, ActorFixture> = {};
  for (const name of Object.keys(value)) {
    const fixture = value[name];
    const option = `actors.${name}`;
    if (!isPlainObject(fixture)) fail(option, `expected { actor, headers? }, got ${describe(fixture)}`);
    knownKeys(option, fixture, ["actor", "headers"]);
    if (!("actor" in fixture)) fail(`${option}.actor`, "required: an actor object or null for anonymous");
    const actor = fixture.actor;
    if (actor !== null) {
      if (!isPlainObject(actor)) fail(`${option}.actor`, `expected an object or null, got ${describe(actor)}`);
      if (typeof actor.id !== "string" || actor.id.length === 0) fail(`${option}.actor.id`, `expected a non-empty string, got ${describe(actor.id)}`);
    }
    let headers: Record<string, string> | undefined;
    if (fixture.headers !== undefined) {
      if (!isPlainObject(fixture.headers) || Object.values(fixture.headers).some((v) => typeof v !== "string")) {
        fail(`${option}.headers`, `expected a record of header strings, got ${describe(fixture.headers)}`);
      }
      headers = Object.freeze({ ...(fixture.headers as Record<string, string>) });
    }
    const frozenActor = actor === null ? null : (Object.freeze({ ...actor }) as ActorFixture["actor"]);
    out[name] = Object.freeze(headers === undefined ? { actor: frozenActor } : { actor: frozenActor, headers });
  }
  const anonymous = out.anonymous;
  if (anonymous === undefined) fail("actors.anonymous", "required: the fixture `anonymous: { actor: null }` (the auth matrix needs it)");
  if (anonymous.actor !== null) fail("actors.anonymous.actor", `must be null, got ${describe(anonymous.actor)}`);
  return Object.freeze(out) as AverriConfig["actors"];
}

function validateEmitter(value: unknown): EmitterConfig {
  if (!isPlainObject(value)) fail("emitter", `expected { publish, spy, eventNamePrefix }, got ${describe(value)}`);
  knownKeys("emitter", value, ["publish", "spy", "eventNamePrefix"]);
  if (typeof value.publish !== "function") fail("emitter.publish", `required: a function (name, payload) => void | Promise<void>, got ${describe(value.publish)}`);
  const spy = value.spy;
  if (!isPlainObject(spy)) fail("emitter.spy", `required: { target, method }, got ${describe(spy)}`);
  knownKeys("emitter.spy", spy, ["target", "method"]);
  if ((typeof spy.target !== "object" || spy.target === null) && typeof spy.target !== "function") {
    fail("emitter.spy.target", `expected the emitter client object, got ${describe(spy.target)}`);
  }
  nonEmptyString("emitter.spy.method", spy.method);
  if (typeof value.eventNamePrefix !== "string") fail("emitter.eventNamePrefix", `required: a string such as "averri/", got ${describe(value.eventNamePrefix)}`);
  return Object.freeze({
    publish: value.publish as EmitterConfig["publish"],
    spy: Object.freeze({ target: spy.target as object, method: spy.method as string }),
    eventNamePrefix: value.eventNamePrefix,
  });
}

function validateSampling(value: unknown): AverriConfig["sampling"] {
  if (!isPlainObject(value)) fail("sampling", `expected { ensures?, invariants? }, got ${describe(value)}`);
  knownKeys("sampling", value, ["ensures", "invariants"]);
  const out = { ...CONFIG_DEFAULTS.sampling };
  for (const key of ["ensures", "invariants"] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !(v >= 0 && v <= 1)) fail(`sampling.${key}`, `expected a number between 0 and 1, got ${describe(v)}`);
    out[key] = v;
  }
  return Object.freeze(out);
}

function validateTest(value: unknown): AverriConfig["test"] {
  if (!isPlainObject(value)) fail("test", `expected { databaseUrlEnv?, generatedDir? }, got ${describe(value)}`);
  knownKeys("test", value, ["databaseUrlEnv", "generatedDir"]);
  const out = { ...CONFIG_DEFAULTS.test };
  if (value.databaseUrlEnv !== undefined) out.databaseUrlEnv = nonEmptyString("test.databaseUrlEnv", value.databaseUrlEnv);
  if (value.generatedDir !== undefined) out.generatedDir = nonEmptyString("test.generatedDir", value.generatedDir);
  return Object.freeze(out);
}

function validatePrismaClient(value: unknown): AverriConfig["prismaClient"] {
  if (!isPlainObject(value)) fail("prismaClient", `expected { file, symbol }, got ${describe(value)}`);
  knownKeys("prismaClient", value, ["file", "symbol"]);
  return Object.freeze({ file: nonEmptyString("prismaClient.file", value.file), symbol: nonEmptyString("prismaClient.symbol", value.symbol) });
}

/** Fills defaults, validates and freezes an `averri.config.ts` input. */
export const defineConfig: DefineConfig = (input: AverriConfigInput): AverriConfig => {
  if (!isPlainObject(input)) fail(null, `expected a configuration object, got ${describe(input)}`);
  knownKeys(null, input, INPUT_KEYS);
  const config: AverriConfig = {
    sourceRoots: input.sourceRoots === undefined ? [...CONFIG_DEFAULTS.sourceRoots] : stringArray("sourceRoots", input.sourceRoots),
    prismaSchema: input.prismaSchema === undefined ? CONFIG_DEFAULTS.prismaSchema : nonEmptyString("prismaSchema", input.prismaSchema),
    prismaClient: input.prismaClient === undefined ? null : validatePrismaClient(input.prismaClient),
    entryPoints: input.entryPoints === undefined ? fail("entryPoints", "required: the files that build the Hono/Express app") : stringArray("entryPoints", input.entryPoints),
    actors: input.actors === undefined ? fail("actors", "required: actor fixtures including `anonymous: { actor: null }`") : validateActors(input.actors),
    emitter: input.emitter === undefined ? null : validateEmitter(input.emitter),
    publicMarker: input.publicMarker === undefined ? null : nonEmptyString("publicMarker", input.publicMarker),
    authMiddleware: input.authMiddleware === undefined ? [...CONFIG_DEFAULTS.authMiddleware] : stringArray("authMiddleware", input.authMiddleware),
    sampling: input.sampling === undefined ? Object.freeze({ ...CONFIG_DEFAULTS.sampling }) : validateSampling(input.sampling),
    test: input.test === undefined ? Object.freeze({ ...CONFIG_DEFAULTS.test }) : validateTest(input.test),
  };
  Object.freeze(config.sourceRoots);
  Object.freeze(config.entryPoints);
  Object.freeze(config.authMiddleware);
  return Object.freeze(config);
};
