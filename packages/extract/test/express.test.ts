import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeValidateEdge, safeValidateNode, type ExposureNode } from "@averri/ir";
import { extractProject, ROUTE_CONFIDENCE } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "fixtures/express-app");
const result = extractProject(root, { prismaSchema: null });
const exposures = result.nodes.filter((n): n is ExposureNode => n.kind === "Exposure");
const byId = (id: string) => exposures.find((e) => e.id === id)!;
const conf = (n: ExposureNode) => (n.provenance.origin === "extracted" ? n.provenance.confidence : -1);

describe("Express 5 route extraction", () => {
  it("extracts exactly the expected Exposure ids", () => {
    expect(exposures.map((e) => e.id)).toEqual([
      "Exposure:express:src/app.ts:12:4",
      "Exposure:express:src/app.ts:17:3",
      "Exposure:express:src/app.ts:20:3",
      "Exposure:express:src/routes/teams.ts:12:8",
      "Exposure:express:src/routes/teams.ts:8:12",
      "Exposure:express:src/routes/teams.ts:9:12",
      "Exposure:express:src/routes/users.ts:6:7",
    ]);
  });

  it("static routes on the root app are 0.98 and carry app-wide use() middleware", () => {
    const health = byId("Exposure:express:src/app.ts:12:4");
    expect(health).toMatchObject({ router: "express", method: "GET", path: "/health", middleware: ["express.json()"], dynamic: false, public: false });
    expect(conf(health)).toBe(ROUTE_CONFIDENCE.root);
  });

  it("supports app.route(path).get(...).post(...) builders", () => {
    expect(byId("Exposure:express:src/app.ts:17:3")).toMatchObject({ method: "GET", path: "/status", handler: { file: "src/app.ts", symbol: "(anonymous)" } });
    expect(byId("Exposure:express:src/app.ts:20:3")).toMatchObject({ method: "POST", path: "/status", handler: { file: "src/handlers.ts", symbol: "statusHandler" } });
  });

  it("composes use(prefix, mw, router) mounts, in-line mount middleware and router.use() in order", () => {
    const invite = byId("Exposure:express:src/routes/teams.ts:9:12");
    expect(invite).toMatchObject({
      method: "POST",
      path: "/teams/:teamId/invitations",
      middleware: ["express.json()", "auth()", 'requireRole("member")', 'requireRole("admin")'],
      handler: { file: "src/handlers.ts", symbol: "inviteMember" },
      bodySchema: { file: "src/schemas.ts", symbol: "InviteInput" },
    });
    expect(conf(invite)).toBe(ROUTE_CONFIDENCE.mounted);
    expect(invite.provenance.origin === "extracted" && invite.provenance.evidence.map((e) => e.note)).toEqual([
      'POST /teams/:teamId/invitations registered via teamsRouter.post("/:teamId/invitations") at src/routes/teams.ts:9:12',
      "mounted at /teams by app.use in src/app.ts:10",
      'express.json() from app.use() at src/app.ts:9',
      'auth() from app.use("/teams") at src/app.ts:10',
      'requireRole("member") from teamsRouter.use() at src/routes/teams.ts:7',
      "body validated by InviteInput (src/schemas.ts)",
    ]);
    expect(byId("Exposure:express:src/routes/teams.ts:8:12")).toMatchObject({ method: "GET", path: "/teams", middleware: ["express.json()", "auth()", 'requireRole("member")'] });
  });

  it("nests express.Router() mounts two levels deep", () => {
    const del = byId("Exposure:express:src/routes/teams.ts:12:8");
    expect(del).toMatchObject({ method: "DELETE", path: "/teams/:teamId/members/:userId", middleware: ["express.json()", "auth()", 'requireRole("member")'], handler: { symbol: "removeMember" } });
    expect(conf(del)).toBe(ROUTE_CONFIDENCE.mounted);
  });

  it("resolves a default-exported Router() through its import", () => {
    expect(byId("Exposure:express:src/routes/users.ts:6:7")).toMatchObject({ method: "GET", path: "/users/me", middleware: ["express.json()"], handler: { file: "src/handlers.ts", symbol: "me" } });
  });

  it("reports stack, warnings and edges", () => {
    expect(result.stack).toMatchObject({ prismaSchema: null, routers: ["express"], validator: "zod", testRunner: null, entryPoints: ["src/app.ts"], configFile: null });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "entry-points-detected" })]);
    expect(result.edges.filter((e) => e.kind === "validatesWith")).toEqual([
      expect.objectContaining({ from: "Exposure:express:src/routes/teams.ts:9:12", to: "Module:src/schemas.ts", attrs: { symbol: "InviteInput" } }),
    ]);
    expect(result.nodes.find((n) => n.id === "Module:src/routes/users.ts")).toMatchObject({ role: "route", exports: ["default"] });
    expect(result.nodes.find((n) => n.id === "Module:src/handlers.ts")).toMatchObject({ role: "handler" });
    for (const n of result.nodes) expect(safeValidateNode(n).ok, n.id).toBe(true);
    for (const e of result.edges) expect(safeValidateEdge(e).ok).toBe(true);
  });

  it("warns when the default Prisma schema is missing", () => {
    const r = extractProject(root, { include: { routes: false, zod: false, tests: false, modules: false } });
    expect(r.warnings).toEqual([{ code: "prisma-schema-missing", message: "Prisma schema prisma/schema.prisma not found", file: "prisma/schema.prisma" }]);
    expect(r.nodes).toEqual([]);
    expect(r.prisma).toBeNull();
  });
});
