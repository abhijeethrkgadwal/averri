/**
 * `toHono` / `toExpress` (SPEC-DECLARATIONS §6, D-20): real Hono `app.request()` and Express via supertest.
 */
import express from "express";
import { Hono, type Context } from "hono";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { query, type Actor } from "@averri/core";
import { memoryTraceRecorder, mergeInput, toExpress, toHono } from "../src/index.js";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { OwnerOrAdmin, actors, config, inviteMember, resetBus, seedTables, type InviteInput } from "./helpers/fixtures.js";

let prisma: FakePrisma;
beforeEach(() => {
  prisma = createFakePrisma(seedTables());
  resetBus();
});

function actorFromHeader(header: string | undefined): Actor | null {
  if (header === "Bearer admin") return actors.admin;
  if (header === "Bearer member") return actors.member;
  return null;
}

const listMembers = query("Team.listMembers", {
  route: { method: "GET", path: "/teams/:teamId/members" },
  input: z.object({ teamId: z.string(), limit: z.coerce.number().int().optional() }),
  policy: OwnerOrAdmin,
  run: async ({ input, db }) => {
    const rows = await (db as unknown as FakePrisma).membership!.findMany({ where: { teamId: input.teamId } });
    return rows.slice(0, input.limit ?? rows.length).map((r) => ({ userId: r.userId, at: new Date("2026-10-24T00:00:00Z") }));
  },
});

describe("toHono", () => {
  type Env = { Variables: { user: Actor | null } };

  function build(options: { status?: number } = {}) {
    const recorder = memoryTraceRecorder();
    const seen: InviteInput[] = [];
    const decl = inviteMember({
      run: async ({ input }) => {
        seen.push(input);
        return { email: input.email, status: "pending", teamId: input.teamId, when: new Date("2026-10-24T00:00:00Z") };
      },
      ensures: {},
    });
    const app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("user", actorFromHeader(c.req.header("authorization")));
      await next();
    });
    const runtime = { prisma, config, recorder, ...options };
    app.post("/teams/:teamId/invitations", toHono(decl, { actor: (c: Context<Env>) => c.get("user"), ...runtime }));
    app.get("/teams/:teamId/members", toHono(listMembers, { actor: (c: Context<Env>) => c.get("user"), ...runtime }));
    return { app, recorder, seen };
  }

  const json = (body: unknown, auth?: string) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

  it("builds input as { ...body, ...params } with path params winning, returns 200 JSON", async () => {
    const { app, recorder, seen } = build();
    const res = await app.request("/teams/t1/invitations", json({ teamId: "evil", email: "new@acme.io", role: "member" }, "Bearer admin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ email: "new@acme.io", status: "pending", teamId: "t1", when: "2026-10-24T00:00:00.000Z" });
    expect(seen).toEqual([{ teamId: "t1", email: "new@acme.io", role: "member" }]);
    const trace = recorder.traces[0]!;
    expect(trace.request).toEqual({
      method: "POST",
      path: "/teams/t1/invitations",
      body: { teamId: "evil", email: "new@acme.io", role: "member" },
      headers: expect.objectContaining({ authorization: "[redacted]", "content-type": "application/json" }),
    });
  });

  it("maps 401 / 403 / 412 / 400 through the adapter", async () => {
    const { app } = build();
    const anon = await app.request("/teams/t1/invitations", json({ email: "new@acme.io", role: "member" }));
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: "Unauthenticated" });
    const member = await app.request("/teams/t1/invitations", json({ email: "new@acme.io", role: "member" }, "Bearer member"));
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: "Forbidden", contract: "Policy:Team.OwnerOrAdmin" });
    const dup = await app.request("/teams/t1/invitations", json({ email: "member@acme.io", role: "member" }, "Bearer admin"));
    expect(dup.status).toBe(412);
    expect(await dup.json()).toMatchObject({ error: "PreconditionFailed", contract: "Contract:Team.inviteMember.requires.notAlreadyMember" });
    const bad = await app.request("/teams/t1/invitations", { method: "POST", headers: { authorization: "Bearer admin" }, body: "not json" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "ValidationFailed" });
  });

  it("GET uses the query string merged with params and honours a status override", async () => {
    const { app, recorder } = build({ status: 201 });
    const res = await app.request("/teams/t1/members?limit=1", { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual([{ userId: "u_admin", at: "2026-10-24T00:00:00.000Z" }]);
    expect(recorder.traces[0]?.request?.body).toBeNull();
  });

  it("a custom input extractor replaces the default", async () => {
    const recorder = memoryTraceRecorder();
    const app = new Hono();
    app.post(
      "/x",
      toHono(inviteMember({ ensures: {}, run: async ({ input }) => input }), {
        actor: () => actors.admin,
        input: () => ({ teamId: "t1", email: "custom@acme.io", role: "admin" }),
        prisma,
        config,
        recorder,
      }),
    );
    const res = await app.request("/x", { method: "POST" });
    expect(await res.json()).toEqual({ teamId: "t1", email: "custom@acme.io", role: "admin" });
  });
});

describe("toExpress", () => {
  function build() {
    const recorder = memoryTraceRecorder();
    const decl = inviteMember({ ensures: {}, run: async ({ input }) => ({ email: input.email, teamId: input.teamId }) });
    const app = express();
    app.use(express.json());
    app.post(
      "/teams/:teamId/invitations",
      toExpress(decl, { actor: (req: express.Request) => actorFromHeader(req.header("authorization")), prisma, config, recorder }),
    );
    app.get(
      "/teams/:teamId/members",
      toExpress(listMembers, { actor: (req: express.Request) => actorFromHeader(req.header("authorization")), prisma, config, recorder }),
    );
    app.post(
      "/boom",
      toExpress(decl, {
        actor: () => {
          throw new Error("actor extraction failed");
        },
        prisma,
        config,
        recorder,
      }),
    );
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(418).json({ caught: err.message });
    });
    return { app, recorder };
  }

  it("serves 200 with merged input and records the request", async () => {
    const { app, recorder } = build();
    const res = await request(app).post("/teams/t1/invitations").set("authorization", "Bearer admin").send({ teamId: "evil", email: "new@acme.io", role: "member" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: "new@acme.io", teamId: "t1" });
    expect(recorder.traces[0]?.request).toMatchObject({ method: "POST", path: "/teams/t1/invitations", headers: expect.objectContaining({ authorization: "[redacted]" }) });
  });

  it("maps 403 and GET query input", async () => {
    const { app } = build();
    const denied = await request(app).post("/teams/t1/invitations").set("authorization", "Bearer member").send({ email: "new@acme.io", role: "member" });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "Forbidden" });
    const list = await request(app).get("/teams/t1/members?limit=1").set("authorization", "Bearer admin");
    expect(list.status).toBe(200);
    expect(list.body).toEqual([{ userId: "u_admin", at: "2026-10-24T00:00:00.000Z" }]);
  });

  it("forwards adapter errors to next(err)", async () => {
    const { app } = build();
    const res = await request(app).post("/boom").send({});
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ caught: "actor extraction failed" });
  });
});

describe("mergeInput (D-20, D-41h)", () => {
  it("reads the query for GET and HEAD and the body for everything else; path params win", () => {
    expect(mergeInput("GET", { b: 1 }, { q: "1" }, { id: "p" })).toEqual({ q: "1", id: "p" });
    expect(mergeInput("head", { b: 1 }, { q: "1" }, {})).toEqual({ q: "1" });
    expect(mergeInput("DELETE", { reason: "spam" }, { q: "1" }, { id: "p" })).toEqual({ reason: "spam", id: "p" });
    expect(mergeInput("POST", { id: "body" }, {}, { id: "p" })).toEqual({ id: "p" });
    expect(mergeInput("PATCH", undefined, undefined, undefined)).toEqual({});
  });
});
