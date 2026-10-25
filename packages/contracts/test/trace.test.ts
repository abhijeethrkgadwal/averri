/**
 * JSONL trace recorder (ARCHITECTURE §4): file naming, append, read-back, retention, redaction.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionTrace } from "@averri/core";
import { actorSummary, createTraceRecorder, currentVitestTest, memoryTraceRecorder, pruneTraces, readTraceFile, redactHeaders, toRepoRelative, traceFileName } from "../src/index.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "averri-traces-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sample = (overrides: Partial<ActionTrace> = {}): ActionTrace => ({
  traceId: "t-1",
  action: "Action:Team.inviteMember",
  mode: "declared",
  startedAt: "2026-10-24T10:00:00.000Z",
  durationMs: 1,
  actor: { id: "u_admin", summary: "admin#u_admin" },
  phases: [{ phase: "validate", ok: true }],
  outcome: { ok: true },
  ...overrides,
});

describe("file recorder", () => {
  it("names the file <YYYY-MM-DD>.<pid>.jsonl and appends one JSON line per trace", () => {
    const dir = tmp();
    const now = () => new Date("2026-10-24T23:59:59.000Z");
    const recorder = createTraceRecorder({ dir, now, pid: 4242 });
    expect(recorder.file).toBe(join(dir, "2026-10-24.4242.jsonl"));
    expect(traceFileName(new Date("2026-01-02T00:00:00Z"), 7)).toBe("2026-01-02.7.jsonl");
    expect(existsSync(recorder.file)).toBe(false);
    recorder.record(sample());
    recorder.record(sample({ traceId: "t-2", outcome: { ok: false, phase: "requires", contract: "Contract:x.requires.y", message: "m", committed: false } }));
    const text = readFileSync(recorder.file, "utf8");
    expect(text.split("\n").filter(Boolean).length).toBe(2);
    expect(text.endsWith("\n")).toBe(true);
    const back = readTraceFile(recorder.file);
    expect(back.map((t) => t.traceId)).toEqual(["t-1", "t-2"]);
    expect(back[1]?.outcome).toEqual({ ok: false, phase: "requires", contract: "Contract:x.requires.y", message: "m", committed: false });
  });

  it("serialises Dates and bigints inside traces and skips malformed lines on read", () => {
    const dir = tmp();
    const recorder = createTraceRecorder({ dir, now: () => new Date("2026-10-24T00:00:00Z"), pid: 1 });
    recorder.record(sample({ phases: [{ phase: "requires", ok: false, contract: "Contract:a.requires.b", tier: "expr", evaluated: { "": { lhs: new Date("2026-01-01T00:00:00Z") as unknown, rhs: 1n as unknown } }, durationMs: 0 }] }));
    writeFileSync(recorder.file, `${readFileSync(recorder.file, "utf8")}{not json\n`);
    const back = readTraceFile(recorder.file);
    expect(back.length).toBe(1);
    const phase = back[0]?.phases[0] as { evaluated: Record<string, unknown> };
    expect(phase.evaluated[""]).toEqual({ lhs: "2026-01-01T00:00:00.000Z", rhs: "1" });
    expect(readTraceFile(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("prunes trace files older than the retention window on first write", () => {
    const dir = tmp();
    writeFileSync(join(dir, "2026-10-01.1.jsonl"), "{}\n");
    writeFileSync(join(dir, "2026-10-20.1.jsonl"), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "keep");
    const now = () => new Date("2026-10-24T12:00:00Z");
    expect(pruneTraces(dir, 7, now())).toEqual(["2026-10-01.1.jsonl"]);
    writeFileSync(join(dir, "2026-10-02.1.jsonl"), "{}\n");
    const recorder = createTraceRecorder({ dir, now, pid: 9 });
    recorder.record(sample());
    expect(existsSync(join(dir, "2026-10-02.1.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "2026-10-20.1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(pruneTraces(join(dir, "nope"))).toEqual([]);
  });
});

describe("helpers", () => {
  it("memory recorder keeps and clears traces", () => {
    const recorder = memoryTraceRecorder();
    recorder.record(sample());
    expect(recorder.traces.length).toBe(1);
    recorder.clear();
    expect(recorder.traces).toEqual([]);
  });

  it("actorSummary is <role>#<id> truncated to 40 chars with no other fields", () => {
    expect(actorSummary(null)).toBeNull();
    expect(actorSummary({ id: "u1", role: "admin", email: "secret@x.io" })).toEqual({ id: "u1", summary: "admin#u1" });
    expect(actorSummary({ id: "u1" })).toEqual({ id: "u1", summary: "#u1" });
    const long = actorSummary({ id: "x".repeat(60), role: "owner" })!;
    expect(long.summary.length).toBe(40);
  });

  it("redactHeaders lower-cases names and hides credentials", () => {
    expect(redactHeaders({ Authorization: "Bearer x", Cookie: "s=1", "X-Stripe-Signature": "sig", "Content-Type": "application/json", "X-Api-Key": "k" })).toEqual({
      authorization: "[redacted]",
      cookie: "[redacted]",
      "x-stripe-signature": "[redacted]",
      "content-type": "application/json",
      "x-api-key": "[redacted]",
    });
    expect(redactHeaders(new Headers({ Authorization: "t", Accept: "*/*" }))).toEqual({ authorization: "[redacted]", accept: "*/*" });
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders({ "set-cookie": ["a", "b"], skip: undefined })).toEqual({ "set-cookie": "[redacted]" });
  });

  it("toRepoRelative uses POSIX separators and leaves outside paths absolute", () => {
    expect(toRepoRelative(join("/repo", "tests", "a.test.ts"), "/repo")).toBe("tests/a.test.ts");
    expect(toRepoRelative("/elsewhere/x.ts", "/repo")).toBe("/elsewhere/x.ts");
  });

  it("currentVitestTest reads the running test from expect.getState()", async () => {
    const test = await currentVitestTest();
    expect(test?.title).toContain("currentVitestTest reads the running test");
    expect(test?.file).toMatch(/packages\/contracts\/test\/trace\.test\.ts$/);
  });
});
