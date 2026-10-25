import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeValidateEdge, safeValidateNode, validateNodeId, type ExposureNode } from "@averri/ir";
import { extractProject, ROUTE_CONFIDENCE, type ExtractResult } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "fixtures/hono-app");
const result: ExtractResult = extractProject(root, { entryPoints: ["src/app.ts"], publicMarker: "publicRoute" });
const exposures = result.nodes.filter((n): n is ExposureNode => n.kind === "Exposure");
const byId = (id: string) => exposures.find((e) => e.id === id)!;
const conf = (n: { provenance: { origin: string; confidence?: number } }) => (n.provenance.origin === "extracted" ? (n.provenance as { confidence: number }).confidence : -1);

describe("Hono route extraction", () => {
  it("extracts exactly the expected Exposure ids (method identifier line:col, D-8)", () => {
    expect(exposures.map((e) => e.id)).toEqual([
      "Exposure:hono:src/app.ts:13:4",
      "Exposure:hono:src/app.ts:20:6",
      "Exposure:hono:src/routes/billing.ts:5:3",
      "Exposure:hono:src/routes/billing.ts:6:3",
      "Exposure:hono:src/routes/byParam.ts:4:6",
      "Exposure:hono:src/routes/orphan.ts:5:7",
      "Exposure:hono:src/routes/teams.ts:11:6",
      "Exposure:hono:src/routes/teams.ts:12:6",
      "Exposure:hono:src/routes/teams.ts:13:6",
      "Exposure:hono:src/routes/teams.ts:14:10",
      "Exposure:hono:src/routes/teams.ts:14:17",
      "Exposure:hono:src/routes/teams.ts:15:10",
      "Exposure:hono:src/routes/teams.ts:15:6",
      "Exposure:hono:src/routes/teams.ts:15:7",
      "Exposure:hono:src/routes/teams.ts:15:8",
      "Exposure:hono:src/routes/teams.ts:15:9",
      "Exposure:hono:src/routes/teams.ts:16:6",
      "Exposure:hono:src/routes/versioned.ts:5:10",
    ]);
  });

  it("composes basePath and route() prefixes and attributes use() middleware in order", () => {
    const invite = byId("Exposure:hono:src/routes/teams.ts:12:6");
    expect(invite).toMatchObject({
      router: "hono",
      method: "POST",
      path: "/api/teams/:teamId/invitations",
      name: "POST /api/teams/:teamId/invitations",
      middleware: ["auth()", "requireUser()", 'requireRole("admin")', "validate(InviteMember.input)"],
      handler: { file: "src/members/inviteMember.ts", symbol: "inviteMember" },
      bodySchema: { file: "src/members/inviteMember.ts", symbol: "InviteMember.input" },
      boundTo: null,
      dynamic: false,
      public: false,
    });
    expect(invite.handler?.range?.range[0]).toEqual([11, 0]);
    expect(conf(invite)).toBe(ROUTE_CONFIDENCE.mounted);
    expect(invite.src).toEqual({ file: "src/routes/teams.ts", range: [[12, 0], [12, 100]] });
    expect(invite.provenance.origin === "extracted" && invite.provenance.evidence.map((e) => [e.kind, e.note])).toEqual([
      ["route", 'POST /api/teams/:teamId/invitations registered via teams.post("/:teamId/invitations") at src/routes/teams.ts:12:6'],
      ["route", "mounted at /teams by app.route in src/app.ts:14"],
      ["source", 'auth() from app.use("/teams/*") at src/app.ts:12'],
      ["source", 'requireUser() from teams.use("*") at src/routes/teams.ts:9'],
      ["schema", "body validated by InviteMember.input (src/members/inviteMember.ts)"],
    ]);
    expect(byId("Exposure:hono:src/routes/teams.ts:11:6")).toMatchObject({ method: "GET", path: "/api/teams", middleware: ["auth()", "requireUser()"], handler: { file: "src/handlers.ts", symbol: "listTeams" } });
  });

  it("app-level use() with a non-matching pattern is not attributed; basePath alone gives 0.95", () => {
    const health = byId("Exposure:hono:src/app.ts:13:4");
    expect(health).toMatchObject({ method: "GET", path: "/api/health", middleware: [], dynamic: false, handler: { file: "src/app.ts", symbol: "(anonymous)" } });
    expect(health.handler?.range).toEqual({ file: "src/app.ts", range: [[13, 19], [13, 46]] });
    expect(conf(health)).toBe(ROUTE_CONFIDENCE.mounted);
  });

  it("normalises Hono regex params and trailing slashes and finds schema.parse in the handler body", () => {
    const patch = byId("Exposure:hono:src/routes/teams.ts:13:6");
    expect(patch).toMatchObject({ method: "PATCH", path: "/api/teams/:teamId", bodySchema: { file: "src/schemas.ts", symbol: "UpdateTeam" }, handler: { file: "src/handlers.ts", symbol: "updateTeam" } });
  });

  it("expands on([...]) per listed method using each literal's position and all() with column offsets (D-36)", () => {
    expect(byId("Exposure:hono:src/routes/teams.ts:14:10")).toMatchObject({ method: "PUT", path: "/api/teams/:teamId/members/:userId", handler: { symbol: "removeMember" } });
    expect(byId("Exposure:hono:src/routes/teams.ts:14:17")).toMatchObject({ method: "DELETE", path: "/api/teams/:teamId/members/:userId" });
    const ping = ["15:6", "15:7", "15:8", "15:9", "15:10"].map((p) => byId(`Exposure:hono:src/routes/teams.ts:${p}`));
    expect(ping.map((e) => e.method)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    expect(new Set(ping.map((e) => e.path))).toEqual(new Set(["/api/teams/:teamId/ping"]));
    for (const e of ping) expect(e.src?.range[0]).toEqual([15, 0]);
  });

  it("skips options()/head() registrations", () => {
    expect(exposures.some((e) => e.src?.range[0][0] === 17 && e.src.file === "src/routes/teams.ts")).toBe(false);
  });

  it("marks the configured publicMarker middleware as public", () => {
    const exp = byId("Exposure:hono:src/routes/teams.ts:16:6");
    expect(exp).toMatchObject({ public: true, middleware: ["auth()", "requireUser()", "publicRoute()"], handler: { file: "src/handlers.ts", symbol: "exportTeam" } });
  });

  it("follows a chained default-export router mounted through import", () => {
    expect(byId("Exposure:hono:src/routes/billing.ts:5:3")).toMatchObject({ method: "POST", path: "/api/billing/webhook", middleware: [], handler: { file: "src/handlers.ts", symbol: "stripeWebhook" } });
    expect(byId("Exposure:hono:src/routes/billing.ts:6:3")).toMatchObject({ method: "GET", path: "/api/billing/plans" });
    expect(conf(byId("Exposure:hono:src/routes/billing.ts:6:3"))).toBe(ROUTE_CONFIDENCE.mounted);
  });

  it("dynamic mounts and non-literal paths get 0.6 and dynamic: true with warnings", () => {
    const versioned = byId("Exposure:hono:src/routes/versioned.ts:5:10");
    expect(versioned).toMatchObject({ path: "/api/${version}/info", dynamic: true });
    expect(conf(versioned)).toBe(ROUTE_CONFIDENCE.dynamic);
    const loop = byId("Exposure:hono:src/app.ts:20:6");
    expect(loop).toMatchObject({ path: "/api/${p}", dynamic: true });
    expect(conf(loop)).toBe(ROUTE_CONFIDENCE.dynamic);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "router-dynamic-mount", file: "src/app.ts" }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-dynamic-path", file: "src/app.ts", message: "app.get(p) at src/app.ts:20 has a non-literal path" }));
  });

  it("routers never reached from an entry point and untraceable receivers get 0.5", () => {
    const orphan = byId("Exposure:hono:src/routes/orphan.ts:5:7");
    expect(orphan).toMatchObject({ path: "/lost", dynamic: true, middleware: [] });
    expect(conf(orphan)).toBe(ROUTE_CONFIDENCE.unreached);
    const extra = byId("Exposure:hono:src/routes/byParam.ts:4:6");
    expect(extra).toMatchObject({ path: "/extra", dynamic: true });
    expect(conf(extra)).toBe(ROUTE_CONFIDENCE.unreached);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "router-unreached", file: "src/routes/orphan.ts" }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-receiver-unresolved", file: "src/routes/byParam.ts" }));
  });

  it("emits contains and validatesWith edges", () => {
    const contains = result.edges.filter((e) => e.kind === "contains" && e.from === "Module:src/routes/teams.ts").map((e) => e.to);
    expect(contains).toEqual(exposures.filter((e) => e.src?.file === "src/routes/teams.ts").map((e) => e.id).sort());
    expect(result.edges.filter((e) => e.kind === "validatesWith")).toEqual([
      expect.objectContaining({ from: "Exposure:hono:src/routes/teams.ts:12:6", to: "Module:src/members/inviteMember.ts", attrs: { symbol: "InviteMember.input" } }),
      expect.objectContaining({ from: "Exposure:hono:src/routes/teams.ts:13:6", to: "Module:src/schemas.ts", attrs: { symbol: "UpdateTeam" } }),
    ]);
  });

  it("reports the stack and the entry points used", () => {
    expect(result.stack).toEqual({
      prismaSchema: "prisma/schema.prisma",
      routers: ["hono"],
      validator: "zod",
      testRunner: "vitest",
      entryPoints: ["src/app.ts"],
      configFile: "averri.config.ts",
    });
  });

  it("every node, edge and id validates against @averri/ir", () => {
    for (const n of result.nodes) {
      const r = safeValidateNode(n);
      expect(r.ok, `${n.id}: ${r.ok ? "" : r.issues.join("; ")}`).toBe(true);
      expect(validateNodeId(n.id).ok, n.id).toBe(true);
      expect(n.summary.length).toBeLessThanOrEqual(200);
    }
    const ids = new Set(result.nodes.map((n) => n.id));
    expect(ids.size).toBe(result.nodes.length);
    for (const e of result.edges) {
      expect(safeValidateEdge(e).ok).toBe(true);
      expect(ids.has(e.from), e.from).toBe(true);
      expect(ids.has(e.to), e.to).toBe(true);
    }
    expect(Object.keys(result.evidence).sort()).toEqual(result.nodes.map((n) => n.id));
    for (const n of result.nodes) expect(result.evidence[n.id]!.length).toBeGreaterThan(0);
  });

  it("detects entry points when none are configured and says so", () => {
    const auto = extractProject(root, { include: { prisma: false, tests: false, zod: true, modules: false, routes: true } });
    expect(auto.warnings).toContainEqual(expect.objectContaining({ code: "entry-points-detected" }));
    expect(auto.stack.entryPoints).toEqual(["src/app.ts", "src/routes/orphan.ts"]);
    expect(auto.nodes.filter((n) => n.kind === "Exposure").map((n) => n.id)).toEqual(exposures.map((e) => e.id));
    // without configured entry points an unmounted router is a root, so the orphan is no longer "unreached"
    expect(auto.nodes.find((n) => n.id === "Exposure:hono:src/routes/orphan.ts:5:7")).toMatchObject({ dynamic: false, provenance: { confidence: ROUTE_CONFIDENCE.root } });
    expect(auto.nodes.some((n) => n.kind === "Entity" || n.kind === "Test" || n.kind === "Module")).toBe(false);
    expect(auto.nodes.find((n) => n.id === "Exposure:hono:src/routes/teams.ts:16:6")).toMatchObject({ public: false });
  });
});
