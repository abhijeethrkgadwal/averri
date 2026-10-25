/** Pure units: bound(), gitignore matcher, read_source, agent block, suggest drafting. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILD_TIMEOUT, call, connect, copyProject, tokens, type Connected, type Project } from "./helpers.js";
import {
  AGENT_BLOCK_BEGIN,
  AGENT_BLOCK_END,
  AGENT_BLOCK_FILES,
  agentBlock,
  bound,
  isIgnored,
  mcpServerRegistration,
  parseGitignore,
  readSource,
  upsertAgentBlock,
} from "../src/index.js";
import { draftRequires } from "../src/tools/suggest.js";

describe("bound", () => {
  it("drops list items from the end in step order and reports handles", () => {
    const data = { a: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, pad: "x".repeat(40) })), b: ["keep", "drop"] };
    const r = bound(data, 120, [
      { list: (d) => d.b, keep: 1 },
      { list: (d) => d.a, handle: (i: { id: string }) => i.id },
    ]);
    expect(tokens(r.data)).toBeLessThanOrEqual(120);
    expect(r.truncated).toBe(true);
    expect(r.data.b).toEqual(["keep"]);
    expect(r.more![r.more!.length - 1]).toBe("n9");
    expect(r.data.a.length + r.more!.length).toBe(10);
    expect(data.a).toHaveLength(10);
  });

  it("is a no-op under budget", () => {
    const r = bound({ a: [1, 2, 3] }, 100, [{ list: (d) => d.a }]);
    expect(r).toEqual({ data: { a: [1, 2, 3] }, truncated: false });
  });
});

describe("gitignore matcher", () => {
  let p: Project;
  beforeAll(() => {
    p = copyProject();
    p.write(".gitignore", "# comment\nnode_modules/\n.averri/\n*.log\n/secret.txt\nbuild/\n!build/keep.txt\ndocs/**/draft.md\n");
    p.write("sub/.gitignore", "local.txt\n");
  });
  afterAll(() => p.cleanup());

  it("matches names, directories, anchored and nested patterns", () => {
    expect(isIgnored(p.root, "a/b/debug.log", false)).toBe(true);
    expect(isIgnored(p.root, "secret.txt", false)).toBe(true);
    expect(isIgnored(p.root, "x/secret.txt", false)).toBe(false);
    expect(isIgnored(p.root, ".averri/graph.json", false)).toBe(true);
    expect(isIgnored(p.root, "docs/a/b/draft.md", false)).toBe(true);
    expect(isIgnored(p.root, "sub/local.txt", false)).toBe(true);
    expect(isIgnored(p.root, "other/local.txt", false)).toBe(false);
    expect(isIgnored(p.root, "src/app.ts", false)).toBe(false);
    expect(isIgnored(p.root, "x/node_modules/pkg/index.js", false)).toBe(true);
  });

  it("an ignored directory ignores its contents even when a file is re-included", () => {
    expect(isIgnored(p.root, "build/keep.txt", false)).toBe(true);
  });

  it("parses comments, negation and trailing slashes", () => {
    const rules = parseGitignore("# c\n\n!a\nb/\n");
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ negate: true, dirOnly: false });
    expect(rules[1]).toMatchObject({ negate: false, dirOnly: true });
  });
});

describe("read_source", () => {
  let p: Project;
  beforeAll(() => {
    p = copyProject();
    p.write(".gitignore", ".averri/\nsecret.env\n");
    p.write("secret.env", "TOKEN=1\n");
    p.write("big.txt", `${Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"y".repeat(20)}`).join("\n")}\n`);
    p.write(".averri/traces/2026-10-25.1.jsonl", '{"traceId":"t1"}\n');
    p.write(".averri/other.json", "{}");
  });
  afterAll(() => p.cleanup());

  it("reads a 1-based inclusive range", () => {
    const r = readSource(p.root, "src/db.ts", [1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.file).toBe("src/db.ts");
    expect(r.data.range).toEqual([1, 2]);
    expect(r.data.lines).toBe(2);
    expect(r.data.text.split("\n")).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it("reads the whole file when no range is given and clamps the range end", () => {
    const whole = readSource(p.root, "src/db.ts");
    const clamped = readSource(p.root, "src/db.ts", [1, 9999]);
    expect(whole.ok && clamped.ok).toBe(true);
    if (whole.ok && clamped.ok) expect(clamped.data).toEqual(whole.data);
  });

  it("truncates at a whole line within 4 000 tokens and returns the next-line handle", () => {
    const r = readSource(p.root, "big.txt");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(tokens(r.data)).toBeLessThanOrEqual(4000);
    expect(r.data.text.split("\n")).toHaveLength(r.data.lines);
    expect(r.data.text.endsWith("y".repeat(20))).toBe(true);
    expect(r.more).toEqual([`big.txt:${r.data.range[1] + 1}`]);
    const next = readSource(p.root, "big.txt", [r.data.range[1] + 1, r.data.range[1] + 3]);
    expect(next.ok && next.data.text.startsWith(`line ${r.data.range[1] + 1} `)).toBe(true);
  });

  it("refuses paths outside the root, gitignored files, directories, bad ranges", () => {
    expect(readSource(p.root, "../../package.json")).toMatchObject({ ok: false, error: "bad-input" });
    expect(readSource(p.root, path.resolve(p.root, "..", "..", "package.json"))).toMatchObject({ ok: false, error: "bad-input" });
    expect(readSource(p.root, "secret.env")).toMatchObject({ ok: false, error: "bad-input" });
    expect(readSource(p.root, ".averri/other.json")).toMatchObject({ ok: false, error: "bad-input" });
    expect(readSource(p.root, "src")).toMatchObject({ ok: false, error: "bad-input" });
    expect(readSource(p.root, "src/db.ts", [5, 2])).toMatchObject({ ok: false, error: "bad-input" });
    expect(readSource(p.root, "src/db.ts", [9999, 10000])).toMatchObject({ ok: false, error: "bad-input" });
    expect(readSource(p.root, "src/nope.ts")).toMatchObject({ ok: false, error: "not-found" });
  });

  it("allows .averri/traces despite the .gitignore", () => {
    const r = readSource(p.root, ".averri/traces/2026-10-25.1.jsonl");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.text).toContain("t1");
  });

  it("works through the MCP tool with the envelope", async () => {
    const c = await connect(p.ctx);
    try {
      const r = await call(c.client, "read_source", { file: "src/db.ts", range: [1, 1] });
      expect(r.json).toMatchObject({ ok: true, stale: false, data: { file: "src/db.ts", range: [1, 1], lines: 1 } });
      const bad = await call(c.client, "read_source", { file: "src/db.ts", range: [0, 1] });
      expect(bad.json).toMatchObject({ ok: false, error: "bad-input" });
      const outside = await call(c.client, "read_source", { file: "../outside.txt" });
      expect(outside.json).toMatchObject({ ok: false, error: "bad-input" });
    } finally {
      await c.close();
    }
  }, BUILD_TIMEOUT);
});

describe("agent block", () => {
  it("is at most 40 lines with the normative content", () => {
    const block = agentBlock();
    const lines = block.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines[0]).toBe(AGENT_BLOCK_BEGIN);
    expect(lines[lines.length - 1]).toBe(AGENT_BLOCK_END);
    expect(block).not.toContain("\r");
    for (const phrase of [
      "`overview` once per session",
      "`find` or `impact` before editing",
      "Action:Team.inviteMember",
      "never file paths",
      "instead of raw `tsc`/`vitest`",
      "tests/averri/*.gen.test.ts",
      "acknowledgeWeakening: true",
      '"result.email"',
      "`async (ctx) => boolean`",
      "low-confidence",
      "`read_source`",
      "grep",
      "first `fix`",
    ]) {
      expect(block, phrase).toContain(phrase);
    }
    expect(AGENT_BLOCK_FILES).toEqual(["CLAUDE.md", "AGENTS.md", ".cursor/rules"]);
    expect(mcpServerRegistration()).toEqual({ command: "npx", args: ["-y", "@averri/cli", "mcp"] });
  });

  it("upserts idempotently and preserves surrounding text", () => {
    expect(upsertAgentBlock(null)).toBe(agentBlock());
    expect(upsertAgentBlock("   \n")).toBe(agentBlock());
    const existing = "# My project\n\nSome rules.\n";
    const once = upsertAgentBlock(existing);
    expect(once.startsWith("# My project\n\nSome rules.\n\n")).toBe(true);
    expect(upsertAgentBlock(once)).toBe(once);
    const edited = once.replace("overview", "OVERVIEW") + "\n## After\ntext\n";
    const replaced = upsertAgentBlock(edited);
    expect(replaced).toContain("`overview` once per session");
    expect(replaced.endsWith("## After\ntext\n")).toBe(true);
    expect(replaced.match(/averri:begin/g)).toHaveLength(1);
    expect(upsertAgentBlock("a\r\nb\r\n")).not.toContain("\r");
  });
});

describe("suggest drafting heuristics", () => {
  it("drafts db.none/db.exists from findFirst guards, honouring negation", () => {
    const text = [
      "async (c) => {",
      "  const body = await c.req.json();",
      "  if (await prisma.membership.findFirst({ where: { teamId: c.req.param('teamId'), userId: body.userId } })) {",
      "    return c.json({ error: 'exists' }, 409);",
      "  }",
      "  if (!(await prisma.team.findFirst({ where: { id: params.teamId } }))) throw new HttpError(404);",
      "}",
    ].join("\n");
    const d = draftRequires(text, "src/h.ts", 10);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ name: "noMembershipMatch", source: 'db.none("membership", { teamId: e.input("teamId"), userId: e.input("userId") })' });
    expect(d[0]!.evidence).toBe("src/h.ts:12: if (await prisma.membership.findFirst({ where: { teamId: c.req.param('teamId'), userId: body.userId } })) -> 4xx, drafted as db.none");
    expect(d[1]).toMatchObject({ name: "teamExists", source: 'db.exists("team", { id: e.input("teamId") })' });
  });

  it("drafts negated comparisons against literals and count checks", () => {
    const text = [
      "if (body.role === 'owner') return c.json({}, 403);",
      "if (actor.age < 18) throw new Error('403');",
      "if (await prisma.invitation.count({ where: { email: body.email } }) > 0) return c.json({}, 409);",
      "if (await prisma.invitation.count({ where: { email: body.email } }) === 0) return c.json({}, 404);",
    ].join("\n");
    const d = draftRequires(text, "f.ts", 1);
    expect(d.map((x) => x.source)).toEqual([
      'e.ne("input.role", "owner")',
      'e.gte("actor.age", 18)',
      'db.none("invitation", { email: e.input("email") })',
      'db.exists("invitation", { email: e.input("email") })',
    ]);
    expect(d.map((x) => x.name)).toEqual(["roleValid", "ageValid", "noInvitationMatch", "invitationExists"]);
    expect(d[0]!.needs).toEqual([["@averri/core", "e"]]);
    expect(d[2]!.needs).toEqual([["@averri/core", "db"]]);
  });

  it("ignores unrecognised conditions, compound conditions and non-4xx branches", () => {
    const text = [
      "if (!body.email) return c.json({}, 400);",
      "if (a.b === 1 && c.d === 2) return c.json({}, 400);",
      "if (body.x === 'y') return c.json({}, 200);",
      "if (await prisma.team.findFirst({ where: { id: compute() } })) return c.json({}, 409);",
      "if (body.role === 'owner') console.log('nothing');",
    ].join("\n");
    expect(draftRequires(text, "f.ts", 1)).toEqual([]);
  });

  it("disambiguates repeated clause names", () => {
    const text = ["if (body.a === 1) return c.json({}, 400);", "if (body.a === 2) return c.json({}, 400);"].join("\n");
    expect(draftRequires(text, "f.ts", 1).map((d) => d.name)).toEqual(["aValid", "aValid2"]);
  });
});

