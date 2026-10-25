/**
 * End to end: the real `averri mcp` stdio server (the CLI binary under tsx) against the seed app,
 * driven by the MCP SDK client. Every tool is called once and its envelope checked; `check` runs the
 * seed app's real tsc and Vitest (generated + hand-written tests), so this file is slow by design.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SEED_APP = path.join(REPO, "examples", "seed-app");
const CLI = path.join(REPO, "packages", "cli", "src", "bin.ts");

let client: Client;

interface Envelope {
  ok: boolean;
  stale?: boolean;
  data?: Record<string, unknown>;
  error?: string;
  message?: string;
}

async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
  const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as Envelope;
}

beforeAll(async () => {
  client = new Client({ name: "seed-app-e2e", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", CLI, "--root", SEED_APP, "mcp"],
    cwd: REPO,
    stderr: "pipe",
  });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("averri mcp (stdio) against examples/seed-app", () => {
  it("lists the eight tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it("overview: stack, counts and health of the seed app", async () => {
    const r = await call("overview", {});
    expect(r).toMatchObject({ ok: true, stale: false });
    const counts = (r.data as { counts: Record<string, number> }).counts;
    expect(counts.Entity).toBe(11);
    expect(counts.Exposure).toBeGreaterThanOrEqual(25);
    expect(counts.Action).toBeGreaterThanOrEqual(8);
    expect(counts.Policy).toBeGreaterThanOrEqual(1);
    expect(counts.Workflow).toBe(1);
    expect(counts.Integration).toBe(1);
  }, 300_000);

  it("find, inspect, impact, read_source and suggest answer within their envelopes", async () => {
    const found = await call("find", { query: "invite", kind: "Action" });
    expect(found.ok).toBe(true);
    expect(JSON.stringify(found.data)).toContain("Action:Org.inviteMember");

    const inspected = await call("inspect", { id: "Action:Org.inviteMember" });
    expect(inspected.ok).toBe(true);
    expect(JSON.stringify(inspected.data)).toContain("Policy:Org.OwnerOrAdminUser");

    const impact = await call("impact", { id: "Entity:Membership" });
    expect(impact.ok).toBe(true);
    expect(JSON.stringify(impact.data)).toContain("Action:Org.updateMemberRole");

    const source = await call("read_source", { file: "src/averri/policies.ts", range: [1, 10] });
    expect(source.ok).toBe(true);
    expect(JSON.stringify(source.data)).toContain("actor.type");

    const suggested = await call("suggest", { id: "Exposure:hono:src/routes/organizations.ts:28:19" });
    expect(suggested.ok).toBe(true);
  }, 300_000);

  it("check, then explain: compiler diagnostics, tsc and the seed app's tests in one result", async () => {
    const r = await call("check", { scope: "all" });
    expect(r.ok).toBe(true);
    const data = r.data as { diagnostics: Array<{ severity: string; code: string }>; tests: { failed: number; passed: number } };
    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.tests.failed).toBe(0);
    expect(data.tests.passed).toBeGreaterThan(300);

    // explain reads diagnostics recorded by the check above; on a fresh clone there is no
    // earlier check result, so this must run after check, not before it.
    const diag = await call("explain", { diagId: "D-0001" });
    expect(diag.ok).toBe(true);
  }, 600_000);
});
