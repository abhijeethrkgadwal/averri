import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentBlock, upsertAgentBlock, AGENT_BLOCK_BEGIN as BLOCK_BEGIN, AGENT_BLOCK_END as BLOCK_END } from "@averri/mcp";
import { cli, emptyDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function project(files: Record<string, string> = {}): string {
  const d = emptyDir("init");
  cleanups.push(d.cleanup);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d.root, f)), { recursive: true });
    fs.writeFileSync(path.join(d.root, f), text);
  }
  return d.root;
}

describe("agent block", () => {
  const AGENT_BLOCK = agentBlock();
  it("is at most 40 lines and carries the SPEC-MCP section 8 rules", () => {
    expect(AGENT_BLOCK.trimEnd().split(String.fromCharCode(10)).length).toBeLessThanOrEqual(40);
    for (const phrase of ["`overview` once per session", "acknowledgeWeakening: true", "tests/averri/*.gen.test.ts", "read_source", "first `fix`", "grep"]) expect(AGENT_BLOCK).toContain(phrase);
  });

  it("upserting appends once and replaces in place", () => {
    const once = upsertAgentBlock("# Mine\n\nhello\n");
    expect(once.startsWith("# Mine\n\nhello\n\n")).toBe(true);
    expect(upsertAgentBlock(once)).toBe(once);
    const edited = once.replace("overview", "OVERVIEW");
    expect(upsertAgentBlock(edited)).toBe(once);
    expect(once.indexOf(BLOCK_END)).toBeGreaterThan(once.indexOf(BLOCK_BEGIN));
  });
});

describe("averri init", () => {
  it("creates config, d.ts, the three agent files and adds dependencies", async () => {
    const root = project({ "package.json": JSON.stringify({ name: "x", devDependencies: { vitest: "^2.1.0" } }), "src/app.ts": "export {};\n", "prisma/schema.prisma": "model A { id Int @id }\n" });
    const r = await cli(root, ["init", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect([...out.created].sort()).toEqual([".cursor/rules/averri.mdc", "AGENTS.md", "CLAUDE.md", "averri.config.ts", "src/averri.d.ts"]);
    expect(out.updated).toEqual(["package.json"]);
    expect(out.install).toBe("npm install");
    expect(out.mcp.claudeCode).toContain("claude mcp add averri");
    const cfg = fs.readFileSync(path.join(root, "averri.config.ts"), "utf8");
    expect(cfg).toContain('entryPoints: ["src/app.ts"]');
    expect(cfg).toContain("anonymous: { actor: null }");
    expect(fs.readFileSync(path.join(root, ".cursor/rules/averri.mdc"), "utf8")).toMatch(/^---\ndescription:.*\nalwaysApply: true\n---\n/);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.devDependencies.vitest).toBe("^2.1.0");
    expect(pkg.devDependencies["fast-check"]).toBeDefined();
    expect(pkg.devDependencies["@averri/contracts"]).toBeDefined();
    expect(pkg.dependencies["@averri/core"]).toBeDefined();
    for (const f of ["averri.config.ts", "src/averri.d.ts", "CLAUDE.md", "AGENTS.md", ".cursor/rules/averri.mdc", "package.json"]) expect(fs.readFileSync(path.join(root, f), "utf8")).not.toContain("\r");
  });

  it("is idempotent and keeps existing content", async () => {
    const root = project({ "CLAUDE.md": "# Project rules\n\nBe kind.\n", "averri.config.ts": "// mine\nexport default {};\n" });
    await cli(root, ["init"]);
    const first = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(first.startsWith("# Project rules\n\nBe kind.\n")).toBe(true);
    expect(first.split(BLOCK_BEGIN).length).toBe(2);
    const second = await cli(root, ["init", "--json"]);
    const out = second.json();
    expect(out.created).toEqual([]);
    expect(out.updated).toEqual([]);
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe(first);
    expect(fs.readFileSync(path.join(root, "averri.config.ts"), "utf8")).toBe("// mine\nexport default {};\n");
  });

  it("--force rewrites the config; --no-package-json leaves package.json alone", async () => {
    const root = project({ "package.json": JSON.stringify({ name: "x" }), "averri.config.ts": "// old\n" });
    await cli(root, ["init", "--force", "--no-package-json"]);
    expect(fs.readFileSync(path.join(root, "averri.config.ts"), "utf8")).toContain("defineConfig");
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))).toEqual({ name: "x" });
  });

  it("prints MCP snippets in the human rendering", async () => {
    const root = project();
    const r = await cli(root, ["init"]);
    expect(r.stdout).toContain("created   averri.config.ts");
    expect(r.stdout).toContain("claude mcp add averri -- npx averri mcp");
    expect(r.stdout).toContain('"mcpServers"');
  });
});
