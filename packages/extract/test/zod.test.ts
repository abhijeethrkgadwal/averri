import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractProject, extractZodSchemas, loadProject } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "fixtures/hono-app");
const result = extractProject(root, { entryPoints: ["src/app.ts"], include: { prisma: false, tests: false, modules: false } });
const fact = (symbol: string) => result.zodSchemas.find((z) => z.ref.symbol === symbol)!;

describe("Zod schema extraction", () => {
  it("finds exported object schemas and their top-level fields, sorted by file and symbol", () => {
    expect(result.zodSchemas.map((z) => `${z.ref.file}#${z.ref.symbol}`)).toEqual([
      "src/members/inviteMember.ts#InviteMember.input",
      "src/schemas.ts#Base",
      "src/schemas.ts#Internal",
      "src/schemas.ts#InviteInput",
      "src/schemas.ts#List",
      "src/schemas.ts#Merged",
      "src/schemas.ts#Omitted",
      "src/schemas.ts#Picked",
      "src/schemas.ts#Spread",
      "src/schemas.ts#UpdateTeam",
      "src/schemas.ts#extraShape.note",
    ]);
    expect(fact("Base")).toMatchObject({ exported: true, fields: ["teamId", "email"], complete: true, method: "ast" });
    expect(fact("Base").ref.range).toEqual({ file: "src/schemas.ts", range: [[3, 13], [3, 79]] });
  });

  it("applies extend / merge / pick / omit and passes through partial/strict", () => {
    expect(fact("InviteInput").fields).toEqual(["teamId", "email", "role"]);
    expect(fact("Merged").fields).toEqual(["teamId", "email", "note"]);
    expect(fact("Picked").fields).toEqual(["email"]);
    expect(fact("Omitted").fields).toEqual(["email", "role"]);
    expect(fact("UpdateTeam")).toMatchObject({ fields: ["name", "slug"], complete: true });
  });

  it("supports object-literal members (InviteMember.input) with a dotted symbol", () => {
    expect(fact("InviteMember.input")).toMatchObject({ ref: { file: "src/members/inviteMember.ts", symbol: "InviteMember.input" }, fields: ["teamId", "email", "role"], exported: true, method: "ast" });
  });

  it("falls back to the TypeChecker for spreads and marks non-object schemas with no fields", () => {
    expect(fact("Spread")).toMatchObject({ method: "checker", complete: true });
    expect([...fact("Spread").fields].sort()).toEqual(["extra", "note"]);
    expect(fact("List")).toMatchObject({ fields: [], complete: true });
    expect(fact("Internal").exported).toBe(true);
    expect(result.zodSchemas.some((z) => z.ref.symbol === "NotZod")).toBe(false);
    expect(result.warnings.filter((w) => w.code === "zod-shape-unresolved")).toEqual([]);
  });

  it("carries schema evidence", () => {
    expect(fact("UpdateTeam").evidence).toEqual([
      expect.objectContaining({ kind: "schema", note: "UpdateTeam: zod object with 2 fields at src/schemas.ts:7" }),
    ]);
    expect(fact("Spread").evidence[0]?.note).toContain("(shape from TypeChecker)");
  });

  it("reports an incomplete shape when neither the AST nor the checker can decide", () => {
    const ctx = loadProject(root, { include: { routes: false } });
    const sf = ctx.project.createSourceFile(path.join(root, "src/__virtual.ts"), 'import { z } from "zod";\nexport const Weird = z.object({ a: z.string() }).merge(makeOther());\nfunction makeOther(): any { return z.object({}); }\n');
    const index = extractZodSchemas(ctx, ["src/__virtual.ts"]);
    expect(index.facts).toHaveLength(1);
    expect(index.facts[0]).toMatchObject({ ref: { symbol: "Weird" }, fields: ["a"], complete: false, method: "ast" });
    expect(index.warnings).toEqual([expect.objectContaining({ code: "zod-shape-unresolved", file: "src/__virtual.ts" })]);
    sf.delete();
  });
});
