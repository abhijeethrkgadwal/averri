import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeValidateNode, safeValidateEdge, validateNodeId, type EntityNode, type FieldNode } from "@averri/ir";
import { extractPrismaSchema, PRISMA_CONFIDENCE } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaFile = "prisma/schema.prisma";
const source = fs.readFileSync(path.join(here, "fixtures/hono-app", schemaFile), "utf8");
const out = extractPrismaSchema(source, schemaFile);
const entity = (name: string) => out.nodes.find((n): n is EntityNode => n.kind === "Entity" && n.name === name)!;
const field = (id: string) => out.nodes.find((n): n is FieldNode => n.kind === "Field" && n.id === id)!;

describe("extractPrismaSchema", () => {
  it("produces one Entity per model with derived clientName, idFields and uniques", () => {
    expect(out.nodes.filter((n) => n.kind === "Entity").map((n) => n.id)).toEqual([
      "Entity:Team",
      "Entity:User",
      "Entity:Membership",
      "Entity:Invitation",
      "Entity:OAuthToken",
    ]);
    const team = entity("Team");
    expect(team.model).toBe("Team");
    expect(team.clientName).toBe("team");
    expect(team.idFields).toEqual(["id"]);
    expect(team.uniques).toEqual([["slug"]]);
    expect(team.fields).toEqual([
      "Field:Team.id",
      "Field:Team.slug",
      "Field:Team.name",
      "Field:Team.tags",
      "Field:Team.createdAt",
      "Field:Team.members",
      "Field:Team.invitations",
      "Field:Team.search",
    ]);
    expect(team.invariants).toEqual([]);
    expect(entity("OAuthToken").clientName).toBe("oAuthToken");
  });

  it("handles compound ids and compound uniques", () => {
    expect(entity("Membership").idFields).toEqual(["teamId", "userId"]);
    expect(entity("Membership").uniques).toEqual([]);
    expect(field("Field:Membership.teamId").isId).toBe(true);
    expect(field("Field:Membership.userId").isId).toBe(true);
    expect(entity("Invitation").uniques).toEqual([["teamId", "email"]]);
    expect(field("Field:Invitation.email").unique).toBe(false);
  });

  it("types fields: scalars with list, enums with values, relations, Unsupported and unknown types", () => {
    expect(field("Field:Team.tags").type).toEqual({ kind: "scalar", name: "String", list: true });
    expect(field("Field:Team.createdAt")).toMatchObject({ type: { kind: "scalar", name: "DateTime", list: false }, hasDefault: true, optional: false });
    expect(field("Field:Invitation.status").type).toEqual({ kind: "enum", name: "InvitationStatus", values: ["PENDING", "ACCEPTED", "REVOKED"], list: false });
    expect(field("Field:OAuthToken.scopes").type).toEqual({ kind: "enum", name: "Role", values: ["OWNER", "ADMIN", "MEMBER"], list: true });
    expect(field("Field:Membership.team").type).toEqual({ kind: "relation", to: "Entity:Team", list: false });
    expect(field("Field:Team.members").type).toEqual({ kind: "relation", to: "Entity:Membership", list: true });
    expect(field("Field:Team.search")).toMatchObject({ type: { kind: "unsupported", raw: 'Unsupported("tsvector")' }, optional: true });
    expect(field("Field:User.name")).toMatchObject({ optional: true, isId: false, unique: false, hasDefault: false });
    expect(field("Field:User.email")).toMatchObject({ unique: true });
    expect(field("Field:OAuthToken.id")).toMatchObject({ type: { kind: "scalar", name: "Int", list: false }, isId: true, hasDefault: true });
  });

  it("marks an unknown type as unsupported at lower confidence with a warning", () => {
    const weird = field("Field:OAuthToken.weird");
    expect(weird.type).toEqual({ kind: "unsupported", raw: "Mystery" });
    expect(weird.provenance).toMatchObject({ origin: "extracted", extractor: "prisma", confidence: PRISMA_CONFIDENCE.unknownType });
    expect(out.warnings).toEqual([{ code: "prisma-unknown-type", message: "OAuthToken.weird has type Mystery, which is not a scalar, enum or model", file: schemaFile }]);
  });

  it("carries schema evidence and source ranges computed from the text", () => {
    const team = entity("Team");
    expect(team.src).toEqual({ file: schemaFile, range: [[23, 0], [34, 1]] });
    expect(team.provenance).toMatchObject({ origin: "extracted", extractor: "prisma", confidence: PRISMA_CONFIDENCE.model });
    expect(team.provenance.origin === "extracted" && team.provenance.evidence[0]).toMatchObject({ kind: "schema", note: "model Team at prisma/schema.prisma:23 (8 fields)" });
    const slug = field("Field:Team.slug");
    expect(slug.src).toEqual({ file: schemaFile, range: [[25, 2], [25, 34]] });
    expect(slug.provenance.origin === "extracted" && slug.provenance.evidence[0]?.note).toBe("Team.slug String at prisma/schema.prisma:25");
  });

  it("emits contains, persistedBy and Module edges/nodes", () => {
    expect(out.module).toMatchObject({ id: "Module:prisma/schema.prisma", role: "prisma-schema", file: schemaFile, exports: ["Team", "User", "Membership", "Invitation", "OAuthToken", "Role", "InvitationStatus"] });
    expect(out.module.lines).toBe(source.split("\n").length - 1);
    const persisted = out.edges.filter((e) => e.kind === "persistedBy");
    expect(persisted.map((e) => [e.from, e.to, e.attrs])).toContainEqual(["Entity:OAuthToken", "Module:prisma/schema.prisma", { model: "oAuthToken" }]);
    expect(out.edges.filter((e) => e.kind === "contains" && e.from === "Module:prisma/schema.prisma").map((e) => e.to)).toEqual([
      "Entity:Team",
      "Entity:User",
      "Entity:Membership",
      "Entity:Invitation",
      "Entity:OAuthToken",
    ]);
    expect(out.edges.filter((e) => e.kind === "contains" && e.from === "Entity:User").map((e) => e.to)).toEqual(entity("User").fields);
  });

  it("reports relation facts with fields/references", () => {
    expect(out.facts.models).toEqual(["Team", "User", "Membership", "Invitation", "OAuthToken"]);
    expect(out.facts.enums).toEqual({ Role: ["OWNER", "ADMIN", "MEMBER"], InvitationStatus: ["PENDING", "ACCEPTED", "REVOKED"] });
    expect(out.facts.relations).toContainEqual({
      from: "Entity:Membership",
      field: "team",
      to: "Entity:Team",
      list: false,
      optional: false,
      fields: ["teamId"],
      references: ["id"],
      name: null,
    });
    expect(out.facts.relations.find((r) => r.from === "Entity:Team" && r.field === "members")).toMatchObject({ list: true, fields: [], references: [] });
  });

  it("every node and edge validates against the IR schemas and id grammar", () => {
    for (const n of [...out.nodes, out.module]) {
      const r = safeValidateNode(n);
      expect(r.ok, `${n.id}: ${r.ok ? "" : r.issues.join("; ")}`).toBe(true);
      expect(validateNodeId(n.id).ok, n.id).toBe(true);
    }
    for (const e of out.edges) expect(safeValidateEdge(e).ok).toBe(true);
  });

  it("skips views, keeps the first of duplicate models and survives a parse error", () => {
    const dup = extractPrismaSchema("model A {\n  id String @id\n}\n\nview V {\n  id String\n}\n\nmodel A {\n  id Int @id\n}\n", "s.prisma");
    expect(dup.nodes.filter((n) => n.kind === "Entity")).toHaveLength(1);
    expect(dup.warnings.map((w) => w.code).sort()).toEqual(["prisma-duplicate-model", "prisma-view-skipped"]);
    const broken = extractPrismaSchema("model {\n", "s.prisma");
    expect(broken.nodes).toEqual([]);
    expect(broken.warnings[0]?.code).toBe("prisma-parse-error");
    expect(broken.module.role).toBe("prisma-schema");
  });

  it("@relation(name) and single-field @@unique groups are recorded", () => {
    const r = extractPrismaSchema(
      'model A {\n  id String @id\n  bId String\n  b B @relation("AB", fields: [bId], references: [id])\n  @@unique([bId])\n}\nmodel B {\n  id String @id\n  as A[]\n}\n',
      "s.prisma",
    );
    expect(r.facts.relations[0]).toMatchObject({ name: "AB", fields: ["bId"], references: ["id"] });
    const a = r.nodes.find((n): n is EntityNode => n.kind === "Entity" && n.name === "A")!;
    expect(a.uniques).toEqual([["bId"]]);
    expect(r.nodes.find((n): n is FieldNode => n.id === "Field:A.bId")!.unique).toBe(true);
  });
});
