import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeValidateNode, type ModuleNode } from "@averri/ir";
import { collectInputFiles, contentHashOf, extractProject, loadProject, sha256 } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "fixtures/hono-app");
const result = extractProject(root, { entryPoints: ["src/app.ts"] });
const modules = result.nodes.filter((n): n is ModuleNode => n.kind === "Module");
const mod = (file: string) => modules.find((m) => m.file === file)!;

describe("Module nodes", () => {
  it("creates one Module per visited file with a role, exports, hash and lines", () => {
    expect(modules.map((m) => m.file)).toEqual([
      "averri.config.ts",
      "prisma/schema.prisma",
      "src/app.ts",
      "src/handlers.ts",
      "src/members/inviteMember.ts",
      "src/middleware/auth.ts",
      "src/middleware/validate.ts",
      "src/routes/billing.ts",
      "src/routes/byParam.ts",
      "src/routes/orphan.ts",
      "src/routes/teams.ts",
      "src/routes/versioned.ts",
      "src/schemas.ts",
      "tests/teams.spec.ts",
    ]);
    expect(mod("averri.config.ts")).toMatchObject({ role: "config", exports: ["default"] });
    expect(mod("prisma/schema.prisma").role).toBe("prisma-schema");
    expect(mod("src/app.ts")).toMatchObject({ role: "route", exports: ["app", "default"], lines: 23 });
    expect(mod("src/routes/billing.ts")).toMatchObject({ role: "route", exports: ["default"] });
    expect(mod("src/handlers.ts")).toMatchObject({ role: "handler", exports: ["listTeams", "removeMember", "exportTeam", "stripeWebhook", "updateTeam"] });
    expect(mod("src/members/inviteMember.ts")).toMatchObject({ role: "handler", exports: ["InviteMember", "inviteMember"] });
    expect(mod("src/middleware/auth.ts")).toMatchObject({ role: "other", exports: ["auth", "requireUser", "requireRole", "publicRoute"] });
    expect(mod("src/schemas.ts").exports).toEqual(["Base", "InviteInput", "UpdateTeam", "Merged", "Picked", "Omitted", "Exposed", "List", "Spread", "NotZod"]);
    expect(mod("tests/teams.spec.ts")).toMatchObject({ role: "test", exports: [] });
    for (const m of modules) {
      expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(m.src).toBeNull();
      expect(safeValidateNode(m).ok).toBe(true);
    }
  });

  it("lists every input file (sources, schema, package.json, config, hand-written tests) and hashes them", () => {
    expect(result.inputFiles.map((f) => f.path)).toEqual([
      "averri.config.ts",
      "package.json",
      "prisma/schema.prisma",
      "src/app.ts",
      "src/handlers.ts",
      "src/members/inviteMember.ts",
      "src/middleware/auth.ts",
      "src/middleware/validate.ts",
      "src/routes/billing.ts",
      "src/routes/byParam.ts",
      "src/routes/orphan.ts",
      "src/routes/teams.ts",
      "src/routes/versioned.ts",
      "src/schemas.ts",
      "tests/teams.spec.ts",
    ]);
    const app = result.inputFiles.find((f) => f.path === "src/app.ts")!;
    expect(app.hash).toBe(mod("src/app.ts").hash);
  });

  it("content hash is deterministic, order-independent and sensitive to any input", () => {
    const again = extractProject(root, { entryPoints: ["src/app.ts"] });
    expect(again.contentHash).toBe(result.contentHash);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const shuffled = [...result.inputFiles].reverse();
    expect(contentHashOf(shuffled)).toBe(result.contentHash);
    const changed = result.inputFiles.map((f) => (f.path === "src/schemas.ts" ? { ...f, hash: sha256("changed") } : f));
    expect(contentHashOf(changed)).not.toBe(result.contentHash);
    expect(contentHashOf(result.inputFiles.filter((f) => f.path !== "tests/teams.spec.ts"))).not.toBe(result.contentHash);
  });

  it("collectInputFiles ignores .averri, dist, node_modules and the generated test dir", () => {
    const ctx = loadProject(root, { entryPoints: ["src/app.ts"] });
    const files = collectInputFiles(ctx).map((f) => f.path);
    expect(files.some((f) => f.includes("tests/averri/"))).toBe(false);
    expect(files).toEqual(result.inputFiles.map((f) => f.path));
    expect(ctx.testFiles).toEqual(["tests/teams.spec.ts"]);
    expect(ctx.sourceFiles).toHaveLength(11);
  });

  it("warns about a missing source root and a missing entry point instead of throwing", () => {
    const r = extractProject(root, { sourceRoots: ["lib"], entryPoints: ["src/nope.ts"], include: { prisma: false, tests: false } });
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        { code: "source-root-missing", message: "source root lib does not exist", file: "lib" },
        { code: "entry-point-missing", message: "entry point src/nope.ts does not exist", file: "src/nope.ts" },
      ]),
    );
    expect(r.nodes.filter((n) => n.kind === "Exposure")).toEqual([]);
  });
});
