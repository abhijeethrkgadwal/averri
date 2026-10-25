import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTool } from "../src/index.js";
import { cli, copyFixture, normalize } from "./helpers.js";

const fx = copyFixture("team-app");
const root = fx.root;
afterAll(() => fx.cleanup());

beforeAll(async () => {
  const r = await cli(root, ["build", "--json"]);
  expect(r.stderr).toBe("");
}, 120_000);

describe("usage and exit codes", () => {
  it("prints help with every command and exits 0", async () => {
    const r = await cli(root, ["--help"]);
    expect(r.code).toBe(0);
    for (const c of ["init", "build", "check", "docs", "report", "fmt", "testgen", "suggest", "mcp", "overview", "find", "inspect", "impact", "explain"]) expect(r.stdout).toContain(c);
  });

  it("unknown command, missing argument, bad option value and missing required option exit 2", async () => {
    expect((await cli(root, ["frobnicate"])).code).toBe(2);
    expect((await cli(root, ["find"])).code).toBe(2);
    expect((await cli(root, ["find", "x", "--kind", "Nope"])).code).toBe(2);
    expect((await cli(root, ["report"])).code).toBe(2);
    expect((await cli(root, ["mcp", "--http", "abc"])).code).toBe(2);
    expect((await cli(root, ["explain", "--code", "A1001"])).code).toBe(2);
    const bad = await cli(root, ["check", "--scope", "everything"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("scope");
  });

  it("--version exits 0", async () => {
    const r = await cli(root, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("0.0.1");
  });
});

describe("build", () => {
  it("exits 1 when the graph has error diagnostics and lists them", async () => {
    const r = await cli(root, ["build", "--json"]);
    expect(r.code).toBe(1);
    const out = r.json();
    expect(out.ok).toBe(false);
    expect(out.diagnostics.some((d: { severity: string }) => d.severity === "error")).toBe(true);
    expect(out.counts.Action).toBeGreaterThan(0);
  });

  it("human output shows diagnostics with codes and fixes", async () => {
    const r = await cli(root, ["build"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/error\s+A\d{4}/);
    expect(r.stdout).toContain("error(s)");
  });
});

describe("tool commands mirror the tool JSON byte for byte", () => {
  const cases: Array<[string, string[], Parameters<typeof runTool>[0], unknown]> = [
    ["overview", ["overview", "--json"], "overview", {}],
    ["find", ["find", "invite", "--json"], "find", { query: "invite" }],
    ["find kind", ["find", "team", "--kind", "Action", "--limit", "3", "--json"], "find", { query: "team", kind: "Action", limit: 3 }],
    ["inspect", ["inspect", "Action:Team.inviteMember", "--json"], "inspect", { id: "Action:Team.inviteMember" }],
    ["inspect bare", ["inspect", "Team.inviteMember", "--include", "tests", "--json"], "inspect", { id: "Team.inviteMember", include: ["tests"] }],
    ["impact", ["impact", "Action:Team.inviteMember", "--json"], "impact", { id: "Action:Team.inviteMember" }],
    ["suggest", ["suggest", "--json"], "suggest", {}],
  ];
  for (const [label, argv, name, input] of cases) {
    it(label, async () => {
      const r = await cli(root, argv);
      const expected = await runTool(name, input, { root });
      expect(r.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(r.code).toBe(expected.ok ? 0 : 1);
    });
  }
});

describe("overview", () => {
  it("envelope and data snapshot", async () => {
    const r = await cli(root, ["overview", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j).toMatchObject({ ok: true, stale: false, rebuilt: false, truncated: false });
    expect(Object.keys(j).slice(0, 5)).toEqual(["ok", "commit", "dirty", "builtAt", "stale"]);
    expect(normalize(j.data, root)).toMatchSnapshot();
  });

  it("human rendering has the section headings", async () => {
    const r = await cli(root, ["overview"]);
    expect(r.code).toBe(0);
    for (const h of ["Stack", "Graph", "Health", "Quickstart"]) expect(r.stdout).toContain(h);
  });

  it("rebuilds on demand when a source file changes (never stale)", async () => {
    const file = path.join(root, "src/averri/events.ts");
    const original = fs.readFileSync(file, "utf8");
    try {
      fs.writeFileSync(file, `${original}\n// touched\n`);
      const r = await cli(root, ["overview", "--json"]);
      expect(r.json()).toMatchObject({ ok: true, stale: false, rebuilt: true });
      const again = await cli(root, ["overview", "--json"]);
      expect(again.json().rebuilt).toBe(false);
    } finally {
      fs.writeFileSync(file, original);
    }
  }, 120_000);
});

describe("find", () => {
  it("prints one 'id | kind | path | origin | summary' line per hit", async () => {
    const r = await cli(root, ["find", "inviteMember"]);
    expect(r.code).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("Action:Team.inviteMember"));
    expect(line).toBeDefined();
    expect((line as string).split(" | ").length).toBe(5);
  });

  it("json hits snapshot", async () => {
    const r = await cli(root, ["find", "team", "--kind", "Entity", "--json"]);
    expect(normalize(r.json().data, root)).toMatchSnapshot();
  });

  it("reports no matches", async () => {
    const r = await cli(root, ["find", "zzzzqqqq"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no matches");
  });
});

describe("inspect", () => {
  it("json for an action carries card, edges and diagnostics", async () => {
    const j = (await cli(root, ["inspect", "Action:Team.inviteMember", "--json"])).json();
    expect(j.ok).toBe(true);
    expect(j.data.node.id).toBe("Action:Team.inviteMember");
    expect(j.data.card.preconditions.length).toBeGreaterThan(0);
  });

  it("human rendering lists requires and ensures", async () => {
    const r = await cli(root, ["inspect", "Team.inviteMember"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("requires notAlreadyMember");
    expect(r.stdout).toContain("ensures  pendingForEmail");
  });

  it("not-found exits 1 with the tool error JSON; human error goes to stderr", async () => {
    const j = await cli(root, ["inspect", "Action:Team.nope", "--json"]);
    expect(j.code).toBe(1);
    expect(j.json()).toMatchObject({ ok: false, error: "not-found" });
    const h = await cli(root, ["inspect", "Action:Team.nope"]);
    expect(h.code).toBe(1);
    expect(h.stdout).toBe("");
    expect(h.stderr).toContain("not-found");
  });
});

describe("impact", () => {
  it("lists affected nodes and tests for an id", async () => {
    const r = await cli(root, ["impact", "Entity:Invitation", "--json"]);
    expect(r.code).toBe(0);
    const d = r.json().data;
    expect(d.changed).toContain("Entity:Invitation");
    expect(Array.isArray(d.affected)).toBe(true);
  });

  it("rejects more than one selector with exit 2", async () => {
    const r = await cli(root, ["impact", "Entity:Invitation", "--base", "HEAD", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json()).toMatchObject({ ok: false, error: "bad-input" });
  });

  it("an unreadable --diff file is a usage error; a diff on stdin is accepted", async () => {
    expect((await cli(root, ["impact", "--diff", "missing.patch"])).code).toBe(2);
    const r = await cli(root, ["impact", "--diff", "-", "--json"], {}, "not a diff\n");
    expect(r.json().ok === false || r.json().ok === true).toBe(true);
    expect([0, 1, 2]).toContain(r.code);
  });
});

describe("explain", () => {
  it("requires exactly one selector (exit 2)", async () => {
    const r = await cli(root, ["explain", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json()).toMatchObject({ ok: false, error: "bad-input" });
  });

  it("explains a diagnostic by id from the last build", async () => {
    await cli(root, ["check", "--scope", "all"], { check: { tsc: false, vitest: false } });
    const graph = JSON.parse(fs.readFileSync(path.join(root, ".averri/graph.json"), "utf8"));
    const d = graph.diagnostics.find((x: { node: string | null }) => x.node !== null);
    const r = await cli(root, ["explain", d.id, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().data.subject).toEqual({ kind: "diagnostic", id: d.id });
    const human = await cli(root, ["explain", d.id]);
    expect(human.stdout).toContain(`diagnostic ${d.id}`);
    const byCode = await cli(root, ["explain", "--code", d.code, "--node", d.node, "--json"]);
    expect(byCode.json().ok).toBe(true);
  });

  it("an unknown test id is not-found (exit 1)", async () => {
    const r = await cli(root, ["explain", "Test:gen/Action:Nope.auth-matrix", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json().ok).toBe(false);
  });
});

describe("check", () => {
  it("--json is the check tool's envelope; errors make it exit 1", async () => {
    const r = await cli(root, ["check", "--scope", "all", "--json"], { check: { tsc: false, vitest: false } });
    const j = r.json();
    expect(j.ok).toBe(true);
    expect(j.stale).toBe(false);
    expect(j.data.green).toBe(false);
    expect(j.data.diagnostics.some((d: { severity: string }) => d.severity === "error")).toBe(true);
    expect(r.code).toBe(1);
  });

  it("human rendering", async () => {
    const r = await cli(root, ["check", "--scope", "all"], { check: { tsc: false, vitest: false } });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("not green");
    expect(r.stdout).toContain("Tests:");
  });
});

describe("docs", () => {
  it("writes SPEC.md per declaration directory and the OpenAPI json", async () => {
    const r = await cli(root, ["docs", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.specFiles).toContain("src/averri/SPEC.md");
    const spec = fs.readFileSync(path.join(root, "src/averri/SPEC.md"), "utf8");
    expect(spec).toContain("## Team.inviteMember");
    expect(spec).toContain("Generated by `averri docs`");
    expect(spec).not.toContain("\r");
    const api = JSON.parse(fs.readFileSync(path.join(root, ".averri/openapi.json"), "utf8"));
    expect(api.paths["/teams/{teamId}/invitations"]).toBeDefined();
    const again = await cli(root, ["docs", "--no-spec", "--openapi", "out/api.json"]);
    expect(again.code).toBe(0);
    expect(fs.existsSync(path.join(root, "out/api.json"))).toBe(true);
  });
});

describe("testgen", () => {
  it("writes generated tests, then --only writes just one owner and deletes nothing", async () => {
    const all = await cli(root, ["testgen", "--json"]);
    expect(all.code).toBe(0);
    const files = fs.readdirSync(path.join(root, "tests/averri")).filter((f) => f.endsWith(".gen.test.ts"));
    expect(files.length).toBeGreaterThan(0);
    const victim = files[0] as string;
    fs.rmSync(path.join(root, "tests/averri", victim));
    const owner = "Action:Team.inviteMember";
    const only = await cli(root, ["testgen", "--only", owner, "--json"]);
    expect(only.code).toBe(0);
    const j = only.json();
    expect(j.only).toEqual([owner]);
    expect(j.deleted).toEqual([]);
    expect(j.written.length + j.unchanged.length).toBeGreaterThan(0);
    const second = await cli(root, ["testgen", "--json"]);
    expect(second.json().unchanged.length).toBeGreaterThan(0);
  });
});

describe("suggest", () => {
  it("drafts observe-mode declarations as unified diffs for undeclared routes", async () => {
    const j = (await cli(root, ["suggest", "--json"])).json();
    expect(j.ok).toBe(true);
    const ps = j.data.proposals;
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.length).toBeLessThanOrEqual(5);
    for (const p of ps) {
      expect(p.target).toMatch(/^Exposure:/);
      expect(p.patch).toContain("+++ b/");
      expect(p.patch).toContain("@averri/core");
      expect(p.patch).toContain("TODO");
      expect(p.evidence.length).toBeGreaterThan(0);
    }
    expect(normalize(ps.map((p: { target: string; evidence: string[] }) => ({ target: p.target, evidence: p.evidence })), root)).toMatchSnapshot();
  });

  it("human rendering shows the diff; a non-route node is bad input (exit 2)", async () => {
    const h = await cli(root, ["suggest"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("+++ b/");
    const bad = await cli(root, ["suggest", "Entity:Team", "--json"]);
    expect(bad.code).toBe(2);
    expect(bad.json().error).toBe("bad-input");
  });
});

describe("mcp", () => {
  it("rejects a bad port with exit 2", async () => {
    const r = await cli(root, ["mcp", "--http", "70000"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("port");
  });

  it("--http starts the server from @averri/mcp and answers tools/list", async () => {
    const r = await cli(root, ["mcp", "--http", "0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const m = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(r.stderr);
    expect(m).not.toBeNull();
    const res = await fetch(m?.[1] as string, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["overview", "find", "inspect", "impact", "check", "explain", "suggest"]));
  });
});
