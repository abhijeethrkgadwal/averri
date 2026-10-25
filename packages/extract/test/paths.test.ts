import { describe, expect, it } from "vitest";
import {
  composePath,
  hasWildcard,
  middlewareCallee,
  middlewareMatches,
  normalizeRoutePath,
  routePathsMatch,
  toHttpMethod,
  usePatternMatches,
} from "../src/index.js";

describe("normalizeRoutePath (SPEC-IR §4.1)", () => {
  it("strips Hono regex params and optional markers", () => {
    expect(normalizeRoutePath("/teams/:id{[0-9]+}")).toBe("/teams/:id");
    expect(normalizeRoutePath("/teams/:id?")).toBe("/teams/:id");
  });
  it("collapses slashes, removes the trailing slash and keeps the root", () => {
    expect(normalizeRoutePath("//teams///x/")).toBe("/teams/x");
    expect(normalizeRoutePath("/")).toBe("/");
    expect(normalizeRoutePath("")).toBe("/");
    expect(normalizeRoutePath("teams")).toBe("/teams");
  });
  it("normalises Express 5 wildcards and optional groups but keeps ${} placeholders", () => {
    expect(normalizeRoutePath("/files/*splat")).toBe("/files/*");
    expect(normalizeRoutePath("/users{/:id}")).toBe("/users/:id");
    expect(normalizeRoutePath("/api/${version}/info")).toBe("/api/${version}/info");
  });
});

describe("composePath", () => {
  it("joins static prefixes and the registered path", () => {
    expect(composePath("/api", "/teams", "/")).toBe("/api/teams");
    expect(composePath("/", "/health")).toBe("/health");
    expect(composePath("/api/", "teams/", "/:id/")).toBe("/api/teams/:id");
    expect(composePath()).toBe("/");
  });
});

describe("routePathsMatch", () => {
  it("matches after normalisation with identical param names", () => {
    expect(routePathsMatch("/teams/:teamId/invitations", "/teams/:teamId{[a-z]+}/invitations/")).toBe(true);
    expect(routePathsMatch("/teams/:teamId", "/teams/:id")).toBe(false);
  });
  it("never matches wildcards", () => {
    expect(routePathsMatch("/teams/*", "/teams/*")).toBe(false);
    expect(hasWildcard("/a/:rest*")).toBe(true);
  });
});

describe("usePatternMatches", () => {
  it("Hono: wildcard patterns cover the prefix and everything below; plain patterns are exact", () => {
    expect(usePatternMatches("hono", "/teams/*", "/teams")).toBe(true);
    expect(usePatternMatches("hono", "/teams/*", "/teams/1/invitations")).toBe(true);
    expect(usePatternMatches("hono", "/teams", "/teams/1")).toBe(false);
    expect(usePatternMatches("hono", "/teams", "/teams")).toBe(true);
    expect(usePatternMatches("hono", "*", "/anything")).toBe(true);
    expect(usePatternMatches("hono", "/teams/:id/*", "/teams/9/x")).toBe(true);
    expect(usePatternMatches("hono", "/users/*", "/teams")).toBe(false);
  });
  it("Express: patterns are segment-boundary prefixes", () => {
    expect(usePatternMatches("express", "/teams", "/teams/1/invitations")).toBe(true);
    expect(usePatternMatches("express", "/teams", "/teamsters")).toBe(false);
    expect(usePatternMatches("express", "/teams/:id", "/teams/1/members")).toBe(true);
    expect(usePatternMatches("express", "/", "/x")).toBe(true);
    expect(usePatternMatches("express", null, "/x")).toBe(true);
  });
});

describe("middlewareCallee / middlewareMatches", () => {
  it("returns the bare callee as written", () => {
    expect(middlewareCallee("auth()")).toBe("auth");
    expect(middlewareCallee('requireRole("admin")')).toBe("requireRole");
    expect(middlewareCallee("mw.auth()")).toBe("mw.auth");
    expect(middlewareCallee("auth")).toBe("auth");
    expect(middlewareCallee("zValidator<Env>(\"json\", s)")).toBe("zValidator");
  });
  it("matches by full dotted name or last segment", () => {
    expect(middlewareMatches("mw.auth()", ["auth"])).toBe(true);
    expect(middlewareMatches("mw.auth()", ["mw.auth"])).toBe(true);
    expect(middlewareMatches("requireRole(\"admin\")", ["auth", "requireUser"])).toBe(false);
  });
});

describe("toHttpMethod", () => {
  it("upper-cases the five modelled methods and rejects the rest (D-8)", () => {
    expect(toHttpMethod("post")).toBe("POST");
    expect(toHttpMethod("HEAD")).toBeNull();
    expect(toHttpMethod("options")).toBeNull();
  });
});
