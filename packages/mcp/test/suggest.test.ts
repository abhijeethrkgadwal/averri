/** `suggest` against the team-app fixture, plus a project copy with a handler that has 4xx guards. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyFilePatch, parseUnifiedDiff } from "@averri/compiler";
import { BUILD_TIMEOUT, call, connect, copyProject, tokens, type Connected, type Project } from "./helpers.js";

function exposures(p: Project): Array<any> {
  const graph = JSON.parse(fs.readFileSync(path.join(p.root, ".averri", "graph.json"), "utf8"));
  return Object.values<any>(graph.nodes).filter((n) => n.kind === "Exposure");
}

/** Apply a unified diff of one file to the project's current text (strict, like git apply). */
function apply(p: Project, patch: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of parseUnifiedDiff(patch)) {
    const file = (f.newFile ?? f.oldFile) as string;
    const abs = path.join(p.root, file);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const after = applyFilePatch(before, f);
    expect(after, `patch for ${file} applies`).not.toBeNull();
    out.set(file, after as string);
  }
  return out;
}

describe("suggest on team-app", () => {
  let p: Project;
  let c: Connected;
  beforeAll(async () => {
    p = copyProject();
    c = await connect(p.ctx);
    await call(c.client, "overview");
  }, BUILD_TIMEOUT);
  afterAll(async () => {
    await c?.close();
    p?.cleanup();
  });

  it("without an id ranks undeclared exposures (writes, then path depth) and fits 2 000 tokens", async () => {
    const r = await call(c.client, "suggest");
    expect(r.json.ok).toBe(true);
    expect(tokens(r.json.data)).toBeLessThanOrEqual(2000);
    const targets = (r.json.data.proposals as Array<{ target: string }>).map((x) => x.target);
    const undeclared = exposures(p).filter((x) => x.boundTo === null);
    expect(targets.length).toBe(Math.min(5, undeclared.length));
    for (const t of targets) expect(undeclared.map((x) => x.id)).toContain(t);
    // no write calls anywhere: ranked by path depth (deepest first), then id
    const depth = (id: string): number => undeclared.find((x) => x.id === id).path.split("/").filter(Boolean).length;
    const depths = targets.map(depth);
    expect([...depths].sort((a, b) => b - a)).toEqual(depths);
  });

  it("never writes anything", async () => {
    await call(c.client, "suggest");
    const leftovers = fs.readdirSync(path.join(p.root, "src")).concat(fs.readdirSync(path.join(p.root, "src", "routes"))).filter((f) => f.includes(".averri."));
    expect(leftovers).toEqual([]);
  });

  it("drafts a query for a named GET handler next to the handler module, reusing a shared policy", async () => {
    const x = exposures(p).find((n) => n.method === "GET" && n.path === "/teams/:teamId/invitations");
    const r = await call(c.client, "suggest", { id: x.id });
    expect(r.json.ok).toBe(true);
    const [pr] = r.json.data.proposals;
    expect(pr.target).toBe(x.id);
    const files = apply(p, pr.patch);
    expect([...files.keys()]).toEqual(["src/handlers.averri.ts"]);
    const text = files.get("src/handlers.averri.ts")!;
    expect(text).toContain('import { query } from "@averri/core";');
    expect(text).toContain('import { z } from "zod";');
    expect(text).toContain('export const TeamListInvitation = query("Team.listInvitation", {');
    expect(text).toContain('route: { method: "GET", path: "/teams/:teamId/invitations" }');
    expect(text).toContain("input: z.object({ teamId: z.string() }),");
    expect(text).toContain('intent: "TODO:');
    expect(text).not.toContain("effects:");
    expect(text).toContain("policy: OwnerOrAdmin,");
    expect(text).toContain('import { OwnerOrAdmin } from "./averri/policies.js";');
    expect(text).toContain("handler: listInvitationsHandler,");
    expect(text).toContain('import { listInvitationsHandler } from "./handlers.js";');
    expect(pr.evidence.some((e: string) => e.includes("policy Policy:Team.OwnerOrAdmin reused"))).toBe(true);
    expect(pr.evidence.some((e: string) => e.includes("0 Prisma write"))).toBe(true);
  });

  it("drafts an action with effects and a policy TODO when no sibling policy is shared", async () => {
    const x = exposures(p).find((n) => n.method === "POST" && n.path === "/webhooks/stripe");
    const r = await call(c.client, "suggest", { id: x.id });
    const [pr] = r.json.data.proposals;
    const text = [...apply(p, pr.patch).values()][0]!;
    expect(text).toContain('export const WebhookCreateStripe = action("Webhook.createStripe", {');
    expect(text).toContain('import { action } from "@averri/core";');
    expect(text).toContain('effects: ["db:read"],');
    expect(text).toContain("// policy: TODO");
    expect(text).toContain("input: z.object({}),");
    expect(pr.evidence.some((e: string) => e.includes("no policy suggested"))).toBe(true);
  });

  it("drafts missing intent for a declared Action in canonical key position", async () => {
    const r = await call(c.client, "suggest", { id: "Team.rename" });
    expect(r.json.ok).toBe(true);
    const [pr] = r.json.data.proposals;
    expect(pr.target).toBe("Action:Team.rename");
    const text = apply(p, pr.patch).get("src/averri/actions.ts")!;
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.includes('action("Team.rename"'));
    expect(lines[at + 1]).toBe('  intent: "TODO: describe what Team.rename does and who may call it.",');
    expect(lines[at + 2]).toContain("route:");
  });

  it("reports nothing to draft when the declaration is complete", async () => {
    const r = await call(c.client, "suggest", { id: "Team.inviteMember" });
    expect(r.json.ok).toBe(true);
    expect(r.json.data.proposals).toEqual([]);
    expect(r.json.data.message).toContain("nothing to draft");
  });

  it("rejects a bound Exposure, a wrong node kind and an unknown id", async () => {
    const bound = exposures(p).find((n) => n.boundTo);
    const a = await call(c.client, "suggest", { id: bound.id });
    expect(a.json).toMatchObject({ ok: false, error: "bad-input" });
    expect(a.json.message).toContain(bound.boundTo);
    const b = await call(c.client, "suggest", { id: "Entity:Invitation" });
    expect(b.json).toMatchObject({ ok: false, error: "bad-input" });
    const n = await call(c.client, "suggest", { id: "Action:Nope.nothing" });
    expect(n.json).toMatchObject({ ok: false, error: "not-found" });
  });
});

describe("suggest with guarded handlers", () => {
  let p: Project;
  let c: Connected;
  beforeAll(async () => {
    p = copyProject();
    p.write(
      "src/guarded.ts",
      [
        "// @ts-nocheck",
        'import { prisma } from "./db.js";',
        "",
        "export async function addMemberHandler(c) {",
        "  const body = await c.req.json();",
        '  if (await prisma.membership.findFirst({ where: { teamId: c.req.param("teamId"), email: body.email } })) {',
        '    return c.json({ error: "already a member" }, 409);',
        "  }",
        '  if (body.role === "owner") return c.json({ error: "forbidden" }, 403);',
        "  const m = await prisma.membership.create({ data: { teamId: c.req.param(\"teamId\"), email: body.email } });",
        "  return c.json(m, 201);",
        "}",
        "",
      ].join("\n"),
    );
    p.write(
      "src/routes/members.ts",
      ['// @ts-nocheck', 'import { Hono } from "hono";', 'import { addMemberHandler } from "../guarded.js";', "", "export const memberRoutes = new Hono();", 'memberRoutes.post("/teams/:teamId/members/invite", addMemberHandler);', ""].join("\n"),
    );
    p.edit("src/app.ts", 'import { webhookRoutes } from "./routes/webhooks.js";', 'import { webhookRoutes } from "./routes/webhooks.js";\nimport { memberRoutes } from "./routes/members.js";');
    p.edit("src/app.ts", 'app.route("/", webhookRoutes);', 'app.route("/", webhookRoutes);\napp.route("/", memberRoutes);');
    c = await connect(p.ctx);
  }, BUILD_TIMEOUT);
  afterAll(async () => {
    await c?.close();
    p?.cleanup();
  });

  it("ranks the write route first and drafts requires from the 4xx guards", async () => {
    const all = await call(c.client, "suggest");
    expect(all.json.ok).toBe(true);
    const first = all.json.data.proposals[0];
    expect(first.target).toContain("src/routes/members.ts");
    const text = [...apply(p, first.patch).values()][0]!;
    expect(text).toContain('export const TeamCreateInvite = action("Team.createInvite", {');
    expect(text).toContain("requires: {");
    expect(text).toContain('noMembershipMatch: db.none("membership", { teamId: e.input("teamId"), email: e.input("email") }),');
    expect(text).toContain('roleValid: e.ne("input.role", "owner"),');
    expect(text).toContain('effects: ["db:write"],');
    expect(text).toContain("handler: addMemberHandler,");
    expect(text).toMatch(/import \{ action, (db, e|e, db) \} from "@averri\/core";/);
    expect(first.evidence.some((e: string) => e.includes("1 Prisma write"))).toBe(true);
    expect(first.evidence.some((e: string) => e.includes("drafted as db.none"))).toBe(true);
    expect(first.evidence.some((e: string) => e.includes("src/guarded.ts:6:"))).toBe(true);
  });
});
