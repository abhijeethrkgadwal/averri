/**
 * effect-scan (SPEC-IR §3.1): client recognition, accessor → Entity, write/read op lists,
 * `$transaction(fn)` recursion, interprocedural following to depth 3, `complete: false` on dynamic
 * access / depth overflow / unknown accessors, raw ops, and the A4002 add-only rule when incomplete.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionNode, Graph } from "@averri/ir";
import { build } from "../src/build.js";
import { BUILD_TIMEOUT, copyFixture, type FixtureCopy } from "./helpers.js";

let fx: FixtureCopy;
let graph: Graph;

const SERVICES = `// @ts-nocheck — fixture
export async function inviteService(client, data) {
  return repo(client, data);
}
async function repo(c, data) {
  return c.invitation.create({ data });
}
export async function deep1(c) { return deep2(c); }
async function deep2(c) { return deep3(c); }
async function deep3(c) { return deep4(c); }
async function deep4(c) { return c.team.update({ where: { id: "t" }, data: {} }); }
const bus = { send(_e) {} };
const eventName = (n) => "averri/" + n;
export async function emitsHandler() {
  await bus.send({ name: "averri/MemberInvited", data: {} });
  await bus.send({ name: eventName("TeamRemoved") });
  await bus.send("averri/NotDeclared");
  await bus.send({ name: "other/Audited" });
}
`;

const ACTIONS = `// @ts-nocheck — fixture
import { action } from "@averri/core";
import { z } from "zod";
import { deep1, emitsHandler, inviteService } from "../services.js";
import { OwnerOrAdmin } from "./policies.js";

const input = z.object({ teamId: z.string() });

export const ViaService = action("Scan.viaService", {
  intent: "two levels deep",
  input,
  policy: OwnerOrAdmin,
  effects: ["db:write"],
  run: async ({ tx, input }) => inviteService(tx, { teamId: input.teamId }),
});

export const TooDeep = action("Scan.tooDeep", {
  intent: "four levels deep",
  input,
  policy: OwnerOrAdmin,
  effects: [],
  run: async ({ tx }) => deep1(tx),
});

export const Dynamic = action("Scan.dynamic", {
  intent: "dynamic accessor",
  input,
  policy: OwnerOrAdmin,
  effects: ["db:read"],
  run: async ({ tx }) => {
    const m = "team";
    return tx[m].findMany();
  },
});

export const Nested = action("Scan.nested", {
  intent: "interactive transaction callback",
  input,
  policy: OwnerOrAdmin,
  effects: ["db:write", "db:read"],
  transaction: false,
  run: async (ctx) => ctx.tx.$transaction(async (t2) => {
    await t2.membership.deleteMany({ where: { teamId: ctx.input.teamId } });
    return t2.user.findMany();
  }),
});

export const Raw = action("Scan.raw", {
  intent: "raw sql",
  input,
  policy: OwnerOrAdmin,
  effects: ["db:write"],
  run: async ({ tx }) => tx.$executeRaw\`DELETE FROM "Team"\`,
});

export const ObserveEmit = action("Scan.observeEmit", {
  intent: "observe mode: emits through the project's own bus",
  route: { method: "POST", path: "/scan/emit" },
  input,
  policy: OwnerOrAdmin,
  effects: ["event:emit"],
  handler: emitsHandler,
});

export const Unknown = action("Scan.unknown", {
  intent: "unknown accessor",
  input,
  policy: OwnerOrAdmin,
  effects: ["db:read"],
  run: async ({ tx }) => tx.ghost.findMany(),
});
`;

beforeAll(() => {
  fx = copyFixture("team-app");
  fx.write("src/services.ts", SERVICES);
  fx.write("src/averri/scan.ts", ACTIONS);
  graph = build(fx.root, { writeCache: false, git: false }).graph;
}, BUILD_TIMEOUT);

afterAll(() => fx?.cleanup());

const action = (id: string): ActionNode => graph.nodes[`Action:${id}` as never] as ActionNode;
const a4002 = (id: string) => graph.diagnostics.find((d) => d.code === "A4002" && d.node === `Action:${id}`);

describe("effect-scan", () => {
  it("follows project-local callees that receive the client (depth <= 3)", () => {
    expect(action("Scan.viaService").effects.verified).toEqual({ reads: [], writes: ["Entity:Invitation"], emits: [], calls: [], complete: true });
    expect(action("Scan.viaService").provenance.origin).toBe("verified");
    expect(a4002("Scan.viaService")).toBeUndefined();
  });

  it("marks the scan incomplete beyond depth 3; A4002 then only adds (info)", () => {
    const v = action("Scan.tooDeep").effects.verified;
    expect(v.complete).toBe(false);
    expect(v.writes).toEqual([]);
    expect(a4002("Scan.tooDeep")).toBeUndefined();
    expect(action("Scan.tooDeep").provenance.origin).toBe("declared");
  });

  it("dynamic accessors and unknown accessors make the scan incomplete", () => {
    expect(action("Scan.dynamic").effects.verified.complete).toBe(false);
    expect(action("Scan.unknown").effects.verified.complete).toBe(false);
  });

  it("recurses into $transaction(fn) with the callback parameter as a client", () => {
    const v = action("Scan.nested").effects.verified;
    expect(v).toEqual({ reads: ["Entity:User"], writes: ["Entity:Membership"], emits: [], calls: [], complete: true });
    expect(action("Scan.nested").transaction).toBe(false);
    expect(a4002("Scan.nested")).toBeUndefined();
  });

  it("raw writes count as db:write without an entity", () => {
    const v = action("Scan.raw").effects.verified;
    expect(v.writes).toEqual([]);
    expect(v.complete).toBe(true);
    expect(a4002("Scan.raw")).toBeUndefined();
  });

  it("observe mode: events published by name through the project's emitter are verified emits", () => {
    expect(action("Scan.observeEmit").effects.verified.emits).toEqual(["Event:MemberInvited", "Event:TeamRemoved"]);
    expect(a4002("Scan.observeEmit")).toBeUndefined();
  });

  it("observe-mode handlers are scanned through the TypeChecker/`new PrismaClient()` client", () => {
    const q = graph.nodes["Query:Team.listInvites" as never] as { reads: string[] };
    expect(q.reads).toEqual(["Entity:Invitation"]);
  });
});
