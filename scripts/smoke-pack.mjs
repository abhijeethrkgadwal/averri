#!/usr/bin/env node
/**
 * Pack-and-install smoke test (docs/RELEASING.md). Verifies the published artefacts the way a user gets them:
 *   1. build every package (skip with --skip-build) and `npm pack` all eight into <tmp>/tarballs,
 *   2. inspect the tarballs (dist present, no src, LICENSE/README, no "development" export condition),
 *   3. create a fresh project OUTSIDE the repo, `npm install` the .tgz files plus hono, prisma, vitest, ...,
 *   4. run `averri init|build|overview|testgen|check` and an MCP initialize + tools/list over stdio,
 *      from dist, with no tsx and nothing from the repo on the module path.
 * Cross-platform (Node >= 20). Options: --skip-build, --keep (keep the temp dir), --dir <path>.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const base = flag("--dir") ? path.resolve(args[args.indexOf("--dir") + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), "averri-pack-"));
const ORDER = ["ir", "core", "extract", "testgen", "contracts", "compiler", "mcp", "cli"];
const VERSION = "0.1.0-alpha.0";
const win = process.platform === "win32";

if (base.toLowerCase().startsWith(repo.toLowerCase() + path.sep)) throw new Error("the temp dir must be outside the repository");
fs.mkdirSync(base, { recursive: true });

const results = [];
function step(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) {
    console.error(`\nSmoke test failed at: ${name}\n(temp dir kept: ${base})`);
    process.exit(1);
  }
}

/** Run a command (npm/npx through the shell on Windows), echo it and its (trimmed) output. */
function sh(cmd, cmdArgs, opts = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.map((a) => (a.includes(path.sep) ? path.basename(a) : a)).join(" ")}${opts.cwd ? `   [cwd ${opts.cwd}]` : ""}`);
  const useShell = win && /^(npm|npx)$/.test(cmd);
  const r = spawnSync(useShell ? `${cmd}.cmd` : cmd, cmdArgs, {
    cwd: opts.cwd ?? repo,
    env: { ...process.env, ...opts.env, NODE_OPTIONS: "", NODE_PATH: "" },
    encoding: "utf8",
    shell: useShell,
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (opts.show !== false) {
    const max = opts.lines ?? 12;
    const text = (out.stdout + out.stderr).trim().split("\n");
    console.log(text.slice(0, max).join("\n") + (text.length > max ? `\n... (${text.length - max} more lines)` : ""));
  }
  console.log(`exit ${out.status}`);
  return out;
}

/** Network-touching steps (npm install, Prisma engine download) get up to 3 attempts. */
function shRetry(cmd, cmdArgs, opts = {}) {
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = sh(cmd, cmdArgs, opts);
    if (r.status === 0) break;
    console.log(`attempt ${attempt} failed${attempt < 3 ? ", retrying" : ""}`);
  }
  return r;
}

console.log(`temp dir: ${base}`);
if (!flag("--skip-build")) {
  const b = sh("npm", ["run", "build"], { lines: 5 });
  step("npm run build", b.status === 0);
}

// 1. pack
const tarDir = path.join(base, "tarballs");
fs.rmSync(tarDir, { recursive: true, force: true });
fs.mkdirSync(tarDir, { recursive: true });
const tarballs = [];
for (const p of ORDER) {
  const r = sh("npm", ["pack", "--pack-destination", tarDir, "--silent"], { cwd: path.join(repo, "packages", p), lines: 3 });
  step(`npm pack @averri/${p}`, r.status === 0);
  tarballs.push(path.join(tarDir, r.stdout.trim().split("\n").pop().trim()));
}

// 2. inspect
for (const [i, p] of ORDER.entries()) {
  const t = tarballs[i];
  const files = sh("tar", ["-tzf", path.basename(t)], { cwd: tarDir, show: false }).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const manifest = JSON.parse(sh("tar", ["-xzOf", path.basename(t), "package/package.json"], { cwd: tarDir, show: false }).stdout);
  const problems = [];
  for (const need of ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"]) if (!files.includes(`package/${need}`)) problems.push(`missing ${need}`);
  if (files.some((f) => f.startsWith("package/src/") || f.startsWith("package/test/"))) problems.push("src/test shipped");
  if (files.some((f) => /tsbuildinfo|prepack-bak/.test(f))) problems.push("build state shipped");
  if (JSON.stringify(manifest.exports).includes("development")) problems.push('"development" condition left in exports');
  if (manifest.version !== VERSION) problems.push(`version ${manifest.version}`);
  if (p === "cli" && manifest.bin?.averri !== "./dist/bin.js") problems.push("bin");
  step(`inspect tarball @averri/${p}`, problems.length === 0, problems.join("; ") || `${files.length} files`);
}

// 3. a fresh user project
const app = path.join(base, "app");
fs.rmSync(app, { recursive: true, force: true });
fs.cpSync(path.join(repo, "scripts", "smoke-fixture"), app, { recursive: true });
const env = { DATABASE_URL: "file:./dev.db" };
let r = shRetry("npm", ["install", "--no-audit", "--no-fund", "hono@^4", "@hono/node-server", "zod@^4", "@prisma/client@^6", "@types/node@^20"], { cwd: app, lines: 4 });
step("npm install hono @hono/node-server zod @prisma/client", r.status === 0);
r = shRetry("npm", ["install", "--no-audit", "--no-fund", "--save-dev", "prisma@^6", "vitest@^2", "typescript@^5", ...tarballs], { cwd: app, lines: 6 });
step("npm install prisma vitest typescript + the packed @averri/*.tgz", r.status === 0);
console.log(sh("npm", ["ls", "--all", "@averri/cli"], { cwd: app, show: false }).stdout.trim());

r = shRetry("npx", ["prisma", "generate"], { cwd: app, env, lines: 4 });
step("prisma generate", r.status === 0);
r = shRetry("npx", ["prisma", "db", "push", "--skip-generate"], { cwd: app, env, lines: 4 });
step("prisma db push", r.status === 0);

const averri = (a, o = {}) => sh("npx", ["averri", ...a], { cwd: app, env, ...o });
const parse = (res) => {
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
};

r = averri(["--version"]);
step("averri --version", r.status === 0 && r.stdout.trim() === VERSION, r.stdout.trim());

r = averri(["init"], { lines: 30 });
step("averri init", r.status === 0 && r.stdout.includes("npx -y @averri/cli mcp") && fs.existsSync(path.join(app, "CLAUDE.md")));
r = shRetry("npm", ["install", "--no-audit", "--no-fund"], { cwd: app, lines: 3 });
step("npm install (init added fast-check to package.json)", r.status === 0);

r = averri(["build"], { lines: 15 });
step("averri build", r.status === 0);

r = averri(["overview", "--json"], { show: false });
const ov = parse(r);
console.log(r.stdout.slice(0, 500));
step("averri overview --json", r.status === 0 && ov?.ok === true && ov.data?.stack?.orm === "prisma");

r = averri(["testgen"], { lines: 10 });
const genDir = path.join(app, "tests", "averri");
const genFiles = fs.existsSync(genDir) ? fs.readdirSync(genDir).filter((f) => f.endsWith(".gen.test.ts")) : [];
step("averri testgen", r.status === 0 && genFiles.length > 0, `${genFiles.length} generated test files`);
const imported = new Set(genFiles.flatMap((f) => [...fs.readFileSync(path.join(genDir, f), "utf8").matchAll(/from "(@averri\/[^"]+)"/g)].map((m) => m[1])));
console.log(`generated tests import: ${[...imported].join(", ")}`);

r = averri(["check", "--json"], { show: false });
const chk = parse(r);
console.log((r.stdout || r.stderr).slice(0, 800));
step("averri check --json", r.status === 0 && chk !== null, `exit ${r.status}`);

// 4. MCP over stdio (the SDK client comes in transitively through @averri/mcp)
const mcpScript = path.join(app, "smoke-mcp.mjs");
fs.writeFileSync(
  mcpScript,
  `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
const bin = path.resolve("node_modules/@averri/cli/dist/bin.js");
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], cwd: process.cwd(), stderr: "pipe" }));
const tools = await client.listTools();
console.log(JSON.stringify({ server: client.getServerVersion(), tools: tools.tools.map((t) => t.name) }));
await client.close();
`,
);
r = sh("node", [mcpScript], { cwd: app, show: false });
console.log((r.stdout || r.stderr).trim());
const mcp = parse({ stdout: r.stdout.trim().split("\n").pop() });
step("averri mcp: initialize + tools/list over stdio", r.status === 0 && (mcp?.tools?.length ?? 0) >= 8, mcp ? `${mcp.tools.length} tools` : "");

console.log(`\nAll ${results.length} smoke steps passed.`);
if (flag("--keep") || flag("--dir")) console.log(`kept: ${base}`);
else fs.rmSync(base, { recursive: true, force: true });
