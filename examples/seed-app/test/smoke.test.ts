import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers.js";

describe("smoke: harness, health and 404", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("GET /health answers with the injected clock", async () => {
    const res = await ctx.request("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, time: "2026-10-24T12:00:00.000Z" });
  });

  it("unknown routes return the JSON 404 envelope", async () => {
    const res = await ctx.request("GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("seed data is present", async () => {
    expect(await ctx.db.user.count()).toBe(5);
    expect(await ctx.db.organization.count()).toBe(2);
    expect(await ctx.db.membership.count()).toBe(4);
    expect(await ctx.db.task.count()).toBe(4);
  });
});
