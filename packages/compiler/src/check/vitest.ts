/**
 * Vitest runner for `check`: runs the given test files with the JSON reporter in the project root and
 * maps every assertion back to a Test node: generated titles carry `[Test:gen/...]` and
 * `[Contract:...]` prefixes; hand-written tests are matched by file + title.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handWrittenTestId, type Graph, type TestId, type TestNode, type TestResultSummary } from "@averri/ir";
import { relPath } from "../util.js";

export interface VitestAssertion {
  file: string;
  /** Full title: ancestors and title joined with " > ". */
  title: string;
  status: TestResultSummary["status"];
  failureMessages: string[];
  line: number | null;
}

export interface VitestReport {
  ok: boolean;
  assertions: VitestAssertion[];
  /** Runner error (vitest missing, crash) when no report could be read. */
  error?: string;
}

export type VitestRunner = (root: string, files: string[] | null) => VitestReport;

interface JsonReport {
  testResults?: Array<{
    name: string;
    message?: string;
    assertionResults?: Array<{
      ancestorTitles?: string[];
      title: string;
      fullName?: string;
      status: string;
      failureMessages?: string[];
      location?: { line: number; column: number } | null;
    }>;
  }>;
}

function mapStatus(s: string): TestResultSummary["status"] {
  if (s === "passed") return "passed";
  if (s === "failed") return "failed";
  if (s === "skipped" || s === "pending" || s === "todo" || s === "disabled") return "skipped";
  return "unknown";
}

/** Parse a Vitest (jest-compatible) JSON report. */
export function parseVitestJson(root: string, report: JsonReport): VitestAssertion[] {
  const out: VitestAssertion[] = [];
  for (const file of report.testResults ?? []) {
    const rel = relPath(root, path.isAbsolute(file.name) ? file.name : path.join(root, file.name));
    const assertions = file.assertionResults ?? [];
    if (assertions.length === 0 && file.message) {
      out.push({ file: rel, title: "(file failed to load)", status: "failed", failureMessages: [file.message], line: null });
    }
    for (const a of assertions) {
      out.push({
        file: rel,
        title: [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(" > "),
        status: mapStatus(a.status),
        failureMessages: a.failureMessages ?? [],
        line: a.location?.line ?? null,
      });
    }
  }
  return out;
}

/** Run `npx vitest run <files> --reporter=json`. `files === null` runs the whole suite. */
export const runVitest: VitestRunner = (root, files) => {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "averri-vitest-")), "report.json");
  const args = ["vitest", "run", ...(files ?? []), "--reporter=json", `--outputFile=${outFile}`, "--passWithNoTests"];
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, { cwd: root, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  try {
    if (!fs.existsSync(outFile)) return { ok: false, assertions: [], error: (r.stderr || r.stdout || String(r.error ?? "vitest produced no report")).slice(0, 2000) };
    const report = JSON.parse(fs.readFileSync(outFile, "utf8")) as JsonReport;
    const assertions = parseVitestJson(root, report);
    return { ok: assertions.every((a) => a.status !== "failed"), assertions };
  } finally {
    fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  }
};

const GEN_ID_RE = /\[(Test:gen\/[^\]\s]+)\]/;
const CONTRACT_RE = /\[(Contract:[^\]\s]+)\]/;

/** The Test node id an assertion belongs to. */
export function testIdOf(graph: Graph, a: VitestAssertion): TestId {
  const gen = GEN_ID_RE.exec(a.title);
  if (gen) return gen[1] as TestId;
  const norm = (s: string): string => s.replace(/\s*>\s*/g, " > ").trim();
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== "Test") continue;
    const t = n as TestNode;
    if (!t.generated && t.file === a.file && norm(t.title) === norm(a.title)) return t.id as TestId;
  }
  return handWrittenTestId(a.file, a.line ?? 1);
}

export function contractOf(a: VitestAssertion): `Contract:${string}` | undefined {
  const m = CONTRACT_RE.exec(a.title);
  return m ? (m[1] as `Contract:${string}`) : undefined;
}

/** Pasteable rerun command (SPEC-MCP §6.5). */
export function rerunCommand(a: Pick<VitestAssertion, "file" | "title">): string {
  const leaf = a.title.split(" > ").pop() ?? a.title;
  // -t is a regular expression: escape it so ids in brackets match literally.
  const pattern = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `npx vitest run ${a.file} -t ${JSON.stringify(pattern)}`;
}
