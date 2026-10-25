/**
 * Drives the MCP server in-process through the SDK's InMemoryTransport against a copy of the compiler's
 * team-app fixture: tool definitions, envelope, staleness, budgets, error envelopes, resources, HTTP.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BUILD_TIMEOUT, call, connect, copyProject, tokens, type Connected, type Project } from "./helpers.js";
import { callTool, runHttp, serialize, TOOL_NAMES, toolDescriptors } from "../src/index.js";

let project: Project;
let conn: Connected;

beforeAll(async () => {
  project = copyProject();
  conn = await connect(project.ctx);
}, BUILD_TIMEOUT);

afterAll(async () => {
  await conn?.close();
  project?.cleanup();
});

describe("tool definitions", () => {
  it("lists the six tools plus read_source and suggest in spec order", async () => {
    const { tools } = await conn.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["overview", "find", "inspect", "impact", "check", "explain", "read_source", "suggest"]);
    expect(TOOL_NAMES).toEqual(tools.map((t) => t.name));
  });

  it("generates root-object JSON schemas from the zod schemas", async () => {
    const { tools } = await conn.client.listTools();
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema).not.toHaveProperty("anyOf");
      expect(t.description!.split(/\s+/).length).toBeLessThan(30);
    }
    const find = tools.find((t) => t.name === "find")!;
    const props = find.inputSchema.properties as Record<string, any>;
    expect(find.inputSchema.required).toEqual(["query"]);
    expect(props.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 30, default: 20 });
    expect(props.kind.enum).toContain("Action");
    const explain = tools.find((t) => t.name === "explain")!;
    expect(Object.keys(explain.inputSchema.properties as object).sort()).toEqual(["detail", "diag", "diagId", "testId", "traceId"]);
    expect(toolDescriptors()).toHaveLength(8);
  });
});

describe("envelope and staleness", () => {
  it("wraps results with commit/dirty/builtAt, stale:false and rebuilt", async () => {
    const first = await call(conn.client, "overview");
    expect(first.isError).toBe(false);
    expect(first.json).toMatchObject({ ok: true, stale: false, truncated: false, commit: null, dirty: false });
    expect(typeof first.json.builtAt).toBe("string");
    expect(first.json.rebuilt).toBe(true);
    const second = await call(conn.client, "overview");
    expect(second.json.rebuilt).toBe(false);
    expect(second.json.builtAt).toBe(first.json.builtAt);
  });

  it("returns exactly the JSON the plain function returns (CLI mirror)", async () => {
    const viaMcp = await call(conn.client, "find", { query: "invite" });
    const direct = await callTool("find", { query: "invite" }, project.ctx);
    expect(viaMcp.text).toBe(serialize(direct));
  });

  it("rebuilds when an input file changes and never serves the old graph", async () => {
    const p = copyProject();
    const c = await connect(p.ctx);
    try {
      const a = await call(c.client, "find", { query: "Team.rename" });
      expect(a.json.data.hits[0].id).toBe("Action:Team.rename");
      p.edit("src/averri/actions.ts", 'action("Team.rename"', 'action("Team.renameTeam"');
      const b = await call(c.client, "find", { query: "Team.renameTeam" });
      expect(b.json.rebuilt).toBe(true);
      expect(b.json.data.hits[0].id).toBe("Action:Team.renameTeam");
      const gone = await call(c.client, "find", { query: "Team.rename" });
      expect(gone.json.data.hits.some((h: any) => h.id === "Action:Team.rename")).toBe(false);
    } finally {
      await c.close();
      p.cleanup();
    }
  }, BUILD_TIMEOUT);

  it("returns build-failed (never an old graph) when a rebuild cannot run", async () => {
    const p = copyProject();
    // a held, fresh build lock and a lock timeout: the build cannot start, there is no cached graph
    p.write(".averri/build.lock", "99999 held");
    const ctx = { ...p.ctx, load: { git: false, lockTimeoutMs: 150 } };
    const c = await connect(ctx);
    try {
      const r = await call(c.client, "find", { query: "x" });
      expect(r.isError).toBe(true);
      expect(r.json).toMatchObject({ ok: false, error: "build-failed" });
      expect(r.json.message).toContain("build.lock");
      expect(r.json).not.toHaveProperty("data");
    } finally {
      await c.close();
      p.cleanup();
    }
  });

  it("serialises concurrent callers through the build lock: one rebuild, the rest wait and reuse it", async () => {
    const p = copyProject();
    const c = await connect(p.ctx);
    try {
      const results = await Promise.all([call(c.client, "overview"), call(c.client, "find", { query: "Team" }), call(c.client, "overview")]);
      expect(results.every((r) => r.json.ok)).toBe(true);
      expect(results.filter((r) => r.json.rebuilt).length).toBe(1);
      expect(new Set(results.map((r) => r.json.builtAt)).size).toBe(1);
    } finally {
      await c.close();
      p.cleanup();
    }
  }, BUILD_TIMEOUT);
});

describe("overview", () => {
  it("fits 1 200 tokens and carries stack, counts, health and the quickstart", async () => {
    const r = await call(conn.client, "overview");
    expect(tokens(r.json.data)).toBeLessThanOrEqual(1200);
    expect(r.json.data.stack.orm).toBe("prisma");
    expect(r.json.data.counts.Action).toBeGreaterThan(0);
    expect(r.json.data.health.handlerLineRatioNote).toBe("informational in V0");
    expect(r.json.data.quickstart.split("\n")).toHaveLength(5);
  });

  it("rejects unexpected arguments types as bad-input only when the shape is wrong", async () => {
    const r = await call(conn.client, "overview", { ignored: true });
    expect(r.json.ok).toBe(true);
  });
});

describe("find", () => {
  it("finds by qualifier, honours kind and limit, stays within 800 tokens", async () => {
    const r = await call(conn.client, "find", { query: "Team", limit: 30 });
    expect(r.json.ok).toBe(true);
    expect(tokens(r.json.data)).toBeLessThanOrEqual(800);
    const limited = await call(conn.client, "find", { query: "Team", kind: "Action", limit: 2 });
    expect(limited.json.data.hits.length).toBeLessThanOrEqual(2);
    expect(limited.json.data.hits.every((h: any) => h.kind === "Action")).toBe(true);
  });

  it("validates input: empty query, unknown kind, limit out of range", async () => {
    for (const args of [{ query: "" }, { query: "x", kind: "Nope" }, { query: "x", limit: 31 }, {}]) {
      const r = await call(conn.client, "find", args);
      expect(r.isError).toBe(true);
      expect(r.json).toMatchObject({ ok: false, error: "bad-input" });
    }
  });
});

describe("inspect", () => {
  it("accepts a full id and a bare qualifier and returns the card and edges", async () => {
    const full = await call(conn.client, "inspect", { id: "Action:Team.inviteMember" });
    expect(full.json.ok).toBe(true);
    expect(full.json.data.node.id).toBe("Action:Team.inviteMember");
    expect(full.json.data.card.preconditions.length).toBeGreaterThan(0);
    expect(tokens(full.json.data)).toBeLessThanOrEqual(2000);
    const bare = await call(conn.client, "inspect", { id: "Team.inviteMember" });
    expect(bare.json.data.node.id).toBe("Action:Team.inviteMember");
  });

  it("returns not-found and ambiguous error envelopes with candidates", async () => {
    const nf = await call(conn.client, "inspect", { id: "Action:Nope.nothing" });
    expect(nf.isError).toBe(true);
    expect(nf.json).toMatchObject({ ok: false, error: "not-found" });
    const ids = Object.keys(JSON.parse(fs.readFileSync(path.join(project.root, ".averri", "graph.json"), "utf8")).nodes);
    const byQualifier = new Map<string, string[]>();
    for (const id of ids) byQualifier.set(id.slice(id.indexOf(":") + 1), [...(byQualifier.get(id.slice(id.indexOf(":") + 1)) ?? []), id]);
    const dup = [...byQualifier.entries()].find(([, v]) => v.length > 1);
    if (dup) {
      const amb = await call(conn.client, "inspect", { id: dup[0] });
      expect(amb.json).toMatchObject({ ok: false, error: "ambiguous" });
      expect(amb.json.candidates.sort()).toEqual(dup[1].sort());
    }
  });
});

describe("impact", () => {
  it("lists affected nodes and tests for an id", async () => {
    const r = await call(conn.client, "impact", { id: "Entity:Invitation" });
    expect(r.json.ok).toBe(true);
    expect(r.json.data.changed).toContain("Entity:Invitation");
    expect(r.json.data.affected.length).toBeGreaterThan(0);
    expect(tokens(r.json.data)).toBeLessThanOrEqual(1500);
    expect(r.json.data).toHaveProperty("migrationNeeded");
    expect(r.json.data).toHaveProperty("contractsWeakened");
  });

  it("rejects more than one of id, diff, base as bad-input", async () => {
    const r = await call(conn.client, "impact", { id: "Team.rename", base: "main" });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ ok: false, error: "bad-input" });
    expect(r.json.message).toContain("at most one");
  });

  it("returns not-found for an unknown id", async () => {
    const r = await call(conn.client, "impact", { id: "Action:Nope.nothing" });
    expect(r.json).toMatchObject({ ok: false, error: "not-found" });
  });
});

describe("check", () => {
  it("returns structured diagnostics, tests, coverage and green within 2 000 tokens", async () => {
    const r = await call(conn.client, "check", { scope: "all" });
    expect(r.json.ok).toBe(true);
    expect(tokens(r.json.data)).toBeLessThanOrEqual(2000);
    expect(Array.isArray(r.json.data.diagnostics)).toBe(true);
    expect(r.json.data.tests).toMatchObject({ ran: 0, failed: 0 });
    expect(typeof r.json.data.coverage.message).toBe("string");
    expect(typeof r.json.data.green).toBe("boolean");
    expect(fs.existsSync(path.join(project.root, ".averri", "last-check.json"))).toBe(true);
  }, BUILD_TIMEOUT);

  it("rejects an invalid scope", async () => {
    const r = await call(conn.client, "check", { scope: "everything" });
    expect(r.json).toMatchObject({ ok: false, error: "bad-input" });
  });
});

describe("explain", () => {
  it("requires exactly one key", async () => {
    const none = await call(conn.client, "explain", {});
    expect(none.json).toMatchObject({ ok: false, error: "bad-input" });
    const two = await call(conn.client, "explain", { testId: "Test:x", traceId: "t" });
    expect(two.json).toMatchObject({ ok: false, error: "bad-input" });
    expect(two.json.message).toContain("exactly one");
  });

  it("explains a diagnostic by stable (code, node) key", async () => {
    const graph = JSON.parse(fs.readFileSync(path.join(project.root, ".averri", "graph.json"), "utf8"));
    const d = graph.diagnostics.find((x: any) => x.node);
    expect(d).toBeTruthy();
    const r = await call(conn.client, "explain", { diag: { code: d.code, node: d.node } });
    expect(r.json.ok).toBe(true);
    expect(r.json.data.subject.kind).toBe("diagnostic");
    expect(tokens(r.json.data)).toBeLessThanOrEqual(1500);
  });

  it("returns not-found for an unknown test or stale diagId", async () => {
    const t = await call(conn.client, "explain", { testId: "Test:gen/Nope.nothing.auth-matrix" });
    expect(t.json).toMatchObject({ ok: false, error: "not-found" });
    const d = await call(conn.client, "explain", { diagId: "D-0042" });
    expect(d.json).toMatchObject({ ok: false, error: "not-found" });
  });
});

describe("resources", () => {
  const DOCS = ["core", "entity", "policy", "action", "query", "event", "workflow", "integration", "contracts", "identity", "tests", "graph", "check", "config"];

  it("lists every docs resource and the card template", async () => {
    const { resources } = await conn.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(DOCS.map((n) => `averri://docs/${n}`).sort());
    const { resourceTemplates } = await conn.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["averri://card/{id}"]);
  });

  it("serves docs within budget: core <= 1 500 tokens, others <= 300", async () => {
    for (const name of DOCS) {
      const r = await conn.client.readResource({ uri: `averri://docs/${name}` });
      const c = r.contents[0] as { text: string; mimeType: string };
      expect(c.mimeType).toBe("text/markdown");
      expect(Math.ceil(c.text.length / 4), name).toBeLessThanOrEqual(name === "core" ? 1500 : 300);
      expect(c.text.length).toBeGreaterThan(100);
    }
    const core = (await conn.client.readResource({ uri: "averri://docs/core" })).contents[0] as { text: string };
    expect(core.text).toContain("Team.inviteMember");
    expect(core.text).toContain("averri://docs/action");
    expect(core.text).toContain('"db:read", "db:write", "event:emit", "network"');
  });

  it("serves a node card by URI-encoded id and by bare qualifier", async () => {
    const enc = await conn.client.readResource({ uri: `averri://card/${encodeURIComponent("Action:Team.inviteMember")}` });
    const text = (enc.contents[0] as { text: string }).text;
    expect(text).toContain("Team.inviteMember");
    expect(text.split("\n").length).toBeLessThanOrEqual(15);
    const bare = await conn.client.readResource({ uri: "averri://card/Team.inviteMember" });
    expect((bare.contents[0] as { text: string }).text).toBe(text);
  });

  it("errors on unknown resources and unknown cards", async () => {
    await expect(conn.client.readResource({ uri: "averri://docs/nope" })).rejects.toThrow(/unknown docs resource/);
    await expect(conn.client.readResource({ uri: "averri://card/Action%3ANope.nothing" })).rejects.toThrow(/not-found/);
    await expect(conn.client.readResource({ uri: "averri://other/x" })).rejects.toThrow(/unknown resource/);
  });
});

describe("unknown tool", () => {
  it("returns a bad-input error envelope", async () => {
    const r = await call(conn.client, "apply_patch", {});
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ ok: false, error: "bad-input" });
  });
});

describe("streamable HTTP", () => {
  it("serves tools over POST /mcp", async () => {
    const h = await runHttp(project.ctx, 0);
    const client = new Client({ name: "http-test", version: "0.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`)));
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(8);
      const r = await call(client, "find", { query: "Team.rename" });
      expect(r.json.ok).toBe(true);
      expect(r.json.data.hits[0].id).toBe("Action:Team.rename");
      const miss = await fetch(`http://127.0.0.1:${h.port}/elsewhere`, { method: "POST", body: "{}" });
      expect(miss.status).toBe(404);
      const get = await fetch(`http://127.0.0.1:${h.port}/mcp`);
      expect(get.status).toBe(405);
    } finally {
      await client.close();
      await h.close();
    }
  });
});
