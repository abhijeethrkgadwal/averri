import type { EntityNode, FieldNode, Node } from "@averri/ir";
import { describe, expect, it } from "vitest";
import { alteredLiteral, leafSources, notInSample, planPredicateSeed, planRow, planSubjectSeed, refSource } from "../src/fixtures.js";
import { SchemaFacts } from "../src/schema.js";
import { entity, field, graphOf, referenceGraph } from "./fixture-graph.js";

const facts = () => new SchemaFacts(referenceGraph());

describe("SchemaFacts", () => {
  it("resolves flat where keys through to-one relations and derives FK scalars by convention", () => {
    const f = facts();
    const membership = f.entityByClient("membership") as EntityNode;
    const r = f.resolveWhereKey(membership, "user.email");
    expect(r.hops.map((h) => h.name)).toEqual(["user"]);
    expect(r.entity.model).toBe("User");
    expect(r.field?.name).toBe("email");
    expect(r.crossesList).toBe(false);
    expect(f.resolveWhereKey(membership, "nope.x").field).toBeNull();
    const team = f.entityByClient("team") as EntityNode;
    expect(f.resolveWhereKey(team, "members.role").crossesList).toBe(true);
    expect(f.fkFieldFor(membership, f.field(membership, "user") as FieldNode)?.name).toBe("userId");
    expect(f.requiredScalars(membership).map((x) => x.name)).toEqual(["joinedAt", "role", "teamId", "userId"]);
    expect(f.requiredRelations(membership).map((x) => x.name)).toEqual(["team", "user"]);
  });
});

describe("value sources", () => {
  it("refSource reads input/actor from env and rejects other roots", () => {
    expect(refSource({ ref: "input.teamId" })).toEqual({ ok: true, src: 'env.input["teamId"]' });
    expect(refSource({ ref: "input.address.city" })).toEqual({ ok: true, src: 'get(env.input, ["address", "city"])' });
    expect(refSource({ ref: "actor.id" })).toEqual({ ok: true, src: 'actorField(env, "id")' });
    expect(refSource({ ref: "actor.org.id" })).toEqual({ ok: true, src: 'get(actorField(env, "org"), ["id"])' });
    expect(refSource({ ref: "self.id" })).toMatchObject({ ok: false });
  });
  it("alteredLiteral and notInSample leave the original set", () => {
    expect(alteredLiteral("a")).toBe("a_x");
    expect(alteredLiteral(2)).toBe(3);
    expect(alteredLiteral(false)).toBe(true);
    expect(alteredLiteral(null)).toBe("altered");
    expect(notInSample(["a", "a_x"])).toBe("a_x_x");
    expect(notInSample([1, 7, 3])).toBe(8);
    expect(notInSample([true])).toBe(false);
    expect(notInSample([true, false])).toBeNull();
    expect(notInSample([])).toBe("x");
  });
  it("leafSources per operator (satisfy vs falsify)", () => {
    const f = facts();
    const membership = f.entityByClient("membership") as EntityNode;
    const role = f.field(membership, "role");
    expect(leafSources({ key: "role", operator: null, value: { lit: "admin" } }, role)).toEqual({ satisfy: '"admin"', falsify: '"admin_x"' });
    expect(leafSources({ key: "teamId", operator: null, value: { ref: "input.teamId" } }, null)).toEqual({ satisfy: 'env.input["teamId"]', falsify: 'altered(env.input["teamId"])' });
    expect(leafSources({ key: "role", operator: "in", value: { lit: ["owner", "admin"] } }, role)).toEqual({ satisfy: '"owner"', falsify: '"owner_x"' });
    expect(leafSources({ key: "role", operator: "not", value: { lit: "member" } }, role)).toEqual({ satisfy: '"member_x"', falsify: '"member"' });
    expect(leafSources({ key: "seats", operator: "lt", value: { lit: 5 } }, null)).toEqual({ satisfy: "bump(5, -1)", falsify: "5" });
    expect(leafSources({ key: "seats", operator: "lte", value: { ref: "input.max" } }, null)).toEqual({ satisfy: 'env.input["max"]', falsify: 'bump(env.input["max"], 1)' });
    expect(leafSources({ key: "seats", operator: "gt", value: { lit: 5 } }, null)).toEqual({ satisfy: "bump(5, 1)", falsify: "5" });
    expect(leafSources({ key: "seats", operator: "gte", value: { lit: 5 } }, null)).toEqual({ satisfy: "5", falsify: "bump(5, -1)" });
    expect(leafSources({ key: "x", operator: "in", value: { ref: "input.list" } }, null)).toMatchObject({ reason: expect.stringContaining("ref list") });
    expect(leafSources({ key: "x", operator: "lt", value: { op: "len", arg: { ref: "input.s" } } }, null)).toMatchObject({ reason: expect.stringContaining("len") });
    const joinedAt = f.field(membership, "joinedAt");
    expect(leafSources({ key: "joinedAt", operator: null, value: { lit: "2025-01-01" } }, joinedAt)).toEqual({ satisfy: 'new Date("2025-01-01")', falsify: 'new Date("2025-01-02T00:00:00.000Z")' });
  });
});

describe("planRow", () => {
  it("creates required parents first and wires FK scalars (unchecked create)", () => {
    const f = facts();
    const membership = f.entityByClient("membership") as EntityNode;
    const r = planRow(f, { entity: membership, pins: new Map([["teamId", "v_teamId"], ["user.email", "v_email"]]), how: "create", varName: "row", depth: 0, visiting: new Set() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code.vars).toEqual(["row_team", "row_user", "row"]);
    expect(r.code.statements[0]).toMatch(/^const row_team = await ensureRow\(model\(h, "team"\), \{ id: v_teamId \}, \{ id: v_teamId, name: draw\(.*\), seats: draw\(.*\) \}\);$/);
    expect(r.code.statements[1]).toMatch(/^const row_user = await model\(h, "user"\)\.create\(\{ data: \{ email: v_email \} \}\);$/);
    expect(r.code.statements[2]).toMatch(/^const row = await model\(h, "membership"\)\.create\(\{ data: \{ joinedAt: draw\(fc\.date\(.*\)\), role: draw\(fc\.constantFrom\("owner", "admin", "member"\)\), teamId: v_teamId, userId: row_user\["id"\] \} \}\);$/);
  });

  it("fails honestly on list relations, unknown fields, compound ids, cycles, depth and json", () => {
    const f = facts();
    const team = f.entityByClient("team") as EntityNode;
    expect(planRow(f, { entity: team, pins: new Map([["members.role", "x"]]), how: "create", varName: "r", depth: 0, visiting: new Set() })).toMatchObject({ ok: false, reason: expect.stringContaining("list relation") });
    expect(planRow(f, { entity: team, pins: new Map([["ghost", "x"]]), how: "create", varName: "r", depth: 0, visiting: new Set() })).toMatchObject({ ok: false, reason: expect.stringContaining("no field ghost") });
    expect(planRow(f, { entity: { ...team, idFields: ["a", "b"] }, pins: new Map(), how: "create", varName: "r", depth: 0, visiting: new Set() })).toMatchObject({ ok: false, reason: expect.stringContaining("compound") });
    expect(planRow(f, { entity: team, pins: new Map(), how: "create", varName: "r", depth: 0, visiting: new Set([team.id]) })).toMatchObject({ ok: false, reason: expect.stringContaining("cycle") });
    expect(planRow(f, { entity: team, pins: new Map(), how: "create", varName: "r", depth: 4, visiting: new Set() })).toMatchObject({ ok: false, reason: expect.stringContaining("depth") });

    const nodes: Node[] = [
      entity("Doc", ["id", "meta"]),
      field("Doc", "id", { kind: "scalar", name: "String", list: false }, { isId: true, hasDefault: true }),
      field("Doc", "meta", { kind: "scalar", name: "Json", list: false }),
      entity("Child", ["id", "parent"]),
      field("Child", "id", { kind: "scalar", name: "String", list: false }, { isId: true, hasDefault: true }),
      field("Child", "parent", { kind: "relation", to: "Entity:Doc", list: false }),
    ];
    const g = new SchemaFacts(graphOf(nodes));
    expect(planRow(g, { entity: g.entityByClient("doc") as EntityNode, pins: new Map(), how: "create", varName: "r", depth: 0, visiting: new Set() })).toMatchObject({ ok: false, reason: expect.stringContaining("Json") });
    expect(planRow(g, { entity: g.entityByClient("child") as EntityNode, pins: new Map(), how: "create", varName: "r", depth: 0, visiting: new Set() })).toMatchObject({ ok: false, reason: expect.stringContaining("foreign-key") });
  });

  it("required scalar lists default to [] and optional relations are skipped", () => {
    const nodes: Node[] = [
      entity("Tag", ["id", "names", "owner"]),
      field("Tag", "id", { kind: "scalar", name: "Int", list: false }, { isId: true }),
      field("Tag", "names", { kind: "scalar", name: "String", list: true }),
      field("Tag", "owner", { kind: "relation", to: "Entity:Tag", list: false }, { optional: true }),
    ];
    const g = new SchemaFacts(graphOf(nodes));
    const r = planRow(g, { entity: g.entityByClient("tag") as EntityNode, pins: new Map(), how: "create", varName: "r", depth: 0, visiting: new Set() });
    expect(r.ok && r.code.statements).toEqual(['const r = await model(h, "tag").create({ data: { id: draw(fc.integer({ min: 0, max: 1000000 }).map((v) => (v % 1000) + nonceInt() * 1000)), names: [] } });']);
  });
});

describe("planPredicateSeed / planSubjectSeed", () => {
  it("db.exists falsifies a literal-valued column within its domain (else the first key); db.none creates nothing to satisfy", () => {
    const f = facts();
    const exists = planPredicateSeed(f, "seedPolicy", "db.exists", "membership", { teamId: { ref: "input.teamId" }, userId: { ref: "actor.id" }, role: { in: { lit: ["owner", "admin"] } } });
    expect(exists.ok).toBe(true);
    if (!exists.ok) return;
    expect(exists.fn.code).toContain('const v_teamId = env.input["teamId"];');
    expect(exists.fn.code).toContain('const v_userId = actorField(env, "id");');
    // role is a literal column: falsified in place with the enum's remaining value
    expect(exists.fn.code).toContain('const v_role = mode === "falsify" ? "member" : "owner";');
    const refsOnly = planPredicateSeed(f, "seedRefs", "db.exists", "membership", { teamId: { ref: "input.teamId" }, userId: { ref: "actor.id" } });
    expect(refsOnly.ok && refsOnly.fn.code).toContain('const v_teamId = mode === "falsify" ? altered(env.input["teamId"]) : env.input["teamId"];');
    expect(exists.fn.code).toContain("void row_team; void row_user; void row;");
    const none = planPredicateSeed(f, "seedNone", "db.none", "membership", { teamId: { ref: "input.teamId" }, "user.email": { ref: "input.email" } });
    expect(none.ok && none.fn.code).toContain('if (mode === "satisfy") return;');
    expect(none.ok && none.fn.code).toContain('const v_user_email = env.input["email"];');
    expect(none.ok && none.fn.code).toContain('const row_user = await model(h, "user").create({ data: { email: v_user_email } });');
  });
  it("rejects countWhere, unknown models, empty where and list-crossing keys", () => {
    const f = facts();
    expect(planPredicateSeed(f, "s", "db.countWhere", "membership", { teamId: { lit: "x" } })).toMatchObject({ ok: false, reason: expect.stringContaining("countWhere") });
    expect(planPredicateSeed(f, "s", "db.exists", "nope", { id: { lit: "x" } })).toMatchObject({ ok: false, reason: expect.stringContaining("nope") });
    expect(planPredicateSeed(f, "s", "db.exists", "membership", {})).toMatchObject({ ok: false, reason: "empty where" });
    expect(planPredicateSeed(f, "s", "db.exists", "team", { "members.role": { lit: "x" } })).toMatchObject({ ok: false, reason: expect.stringContaining("list relation") });
    expect(planPredicateSeed(f, "s", "db.exists", "team", { ghost: { lit: "x" } })).toMatchObject({ ok: false, reason: expect.stringContaining("ghost") });
  });
  it("subject seeds apply self constraints and reject conflicts", () => {
    const f = facts();
    const team = f.entityByClient("team") as EntityNode;
    const ok = planSubjectSeed(f, "seedSubject", team, { id: { ref: "input.teamId" } }, [{ root: "self", field: "status", ne: ["active"], notIn: [] }]);
    expect(ok.ok && ok.fn.code).toContain('const v_status = draw(fc.constantFrom("active", "suspended").filter((v) => v !== "active"));');
    // the pinned id names a row that may already exist: updated in place, created otherwise
    expect(ok.ok && ok.fn.code).toContain('const row = await ensurePinned(model(h, "team"), { id: v_id }, { id: v_id, status: v_status }, { id: v_id, name: draw(');
    expect(planSubjectSeed(f, "s", team, { id: { ref: "input.teamId" } }, [{ root: "self", field: "id", ne: [], notIn: [], eq: "x" }])).toMatchObject({ ok: false, reason: expect.stringContaining("both") });
    expect(planSubjectSeed(f, "s", team, { id: { in: { lit: ["a"] } } }, [])).toMatchObject({ ok: false, reason: expect.stringContaining("operator") });
    expect(planSubjectSeed(f, "s", team, { id: { ref: "input.teamId" } }, [{ root: "self", field: "ghost", ne: [], notIn: [] }])).toMatchObject({ ok: false, reason: expect.stringContaining("ghost") });
  });
});
