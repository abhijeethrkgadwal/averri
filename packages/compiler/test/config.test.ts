import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, lowerConfigText, readConfig } from "../src/config.js";
import { FIXTURES } from "./helpers.js";

describe("averri.config.ts static lowering", () => {
  it("lowers the seed app's static fields without importing the module", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "seed-mini/averri.config.ts"), "utf8");
    const { config, diagnostics } = lowerConfigText("averri.config.ts", text);
    expect(diagnostics).toEqual([]);
    expect(config.sourceRoots).toEqual(["src"]);
    expect(config.prismaSchema).toBe("prisma/schema.prisma");
    expect(config.entryPoints).toEqual(["src/app.ts"]);
    expect(config.entryPointsDeclared).toBe(true);
    expect(config.authMiddleware).toEqual(["auth", "requireUser", "requireActor", "requireOrgRole"]);
    expect(config.eventNamePrefix).toBe("averri/");
    expect(config.actors).toEqual(["anonymous", "owner", "admin", "member", "otherOrgAdmin", "outsider", "apiKeyMember"]);
    expect(config.actorIds).toMatchObject({ anonymous: null, owner: "u_owner", apiKeyMember: "key_acme_member" });
    expect(config.test).toEqual({ databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" });
  });

  it("uses defaults when there is no config file", () => {
    const { config, diagnostics } = readConfig(path.join(FIXTURES, "does-not-exist"));
    expect(diagnostics).toEqual([]);
    expect(config).toEqual({ file: null, ...CONFIG_DEFAULTS });
  });

  it("reports A1004 for non-analysable static fields and keeps the default", () => {
    const text = [
      'import { defineConfig } from "@averri/core";',
      "const roots = computeRoots();",
      "export default defineConfig({",
      "  sourceRoots: roots,",
      '  entryPoints: ["src/main.ts"],',
      "  prismaSchema: `prisma/${name}.prisma`,",
      "  publicMarker: \"publicRoute\",",
      "  actors: { anonymous: { actor: null }, [dynamic]: { actor: null } },",
      "  emitter: { eventNamePrefix: prefix, publish() {}, spy: { target: {}, method: \"send\" } },",
      "});",
    ].join("\n");
    const { config, diagnostics } = lowerConfigText("averri.config.ts", text);
    expect(diagnostics.map((d) => d.code)).toEqual(["A1004", "A1004", "A1004", "A1004"]);
    expect(diagnostics.every((d) => d.node === "Module:averri.config.ts")).toBe(true);
    expect(config.sourceRoots).toEqual(["src"]);
    expect(config.entryPoints).toEqual(["src/main.ts"]);
    expect(config.prismaSchema).toBe("prisma/schema.prisma");
    expect(config.publicMarker).toBe("publicRoute");
    expect(config.actors).toEqual(["anonymous"]);
    expect(config.eventNamePrefix).toBeNull();
  });

  it("accepts a plain object default export and a const indirection", () => {
    const a = lowerConfigText("averri.config.ts", 'export default { entryPoints: ["a.ts"], test: { generatedDir: "gen" } };').config;
    expect(a.entryPoints).toEqual(["a.ts"]);
    expect(a.test.generatedDir).toBe("gen");
    const b = lowerConfigText("averri.config.ts", 'const c = defineConfig({ authMiddleware: ["auth"] });\nexport default c;').config;
    expect(b.authMiddleware).toEqual(["auth"]);
  });

  it("reports A1004 when the default export is not an object", () => {
    const { diagnostics } = lowerConfigText("averri.config.ts", "export default makeConfig;");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("A1004");
  });
});
