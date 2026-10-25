/**
 * Test helpers: fixture projects are copied under `packages/compiler/test/.tmp/` (gitignored) so that
 * module resolution (zod, hono, @averri/core) walks up to the monorepo's node_modules exactly as for
 * the originals, and so tests can mutate files and write `.averri/` freely.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Graph } from "@averri/ir";

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(TEST_DIR, "fixtures");
export const TMP = path.join(TEST_DIR, ".tmp");
export const GOLDEN = path.join(TEST_DIR, "golden");

export interface FixtureCopy {
  root: string;
  write(rel: string, content: string): void;
  read(rel: string): string;
  edit(rel: string, from: string, to: string): void;
  cleanup(): void;
}

let counter = 0;

export function copyFixture(name: string): FixtureCopy {
  fs.mkdirSync(TMP, { recursive: true });
  const root = path.join(TMP, `${name}-${process.pid}-${Date.now().toString(36)}-${counter++}`);
  fs.cpSync(path.join(FIXTURES, name), root, { recursive: true });
  return {
    root,
    write(rel, content) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    },
    read(rel) {
      return fs.readFileSync(path.join(root, rel), "utf8");
    },
    edit(rel, from, to) {
      const file = path.join(root, rel);
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes(from)) throw new Error(`${rel} does not contain ${JSON.stringify(from)}`);
      fs.writeFileSync(file, text.replace(from, to));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Stable projection of diagnostics for golden files (ids and since_last_green are build-specific). */
export function goldenDiagnostics(graph: Graph): unknown[] {
  return graph.diagnostics.map((d: Diagnostic) => ({
    code: d.code,
    severity: d.severity,
    node: d.node,
    path: d.path,
    title: d.title,
    ...(d.message ? { message: d.message } : {}),
    cause: d.cause,
    related: d.related,
    fixes: d.fixes.map((f) => ({ label: f.label, evidence: f.evidence, ...(f.patch ? { patch: f.patch } : {}), ...(f.command ? { command: f.command } : {}) })),
  }));
}

/** Compare with (or, with UPDATE_GOLDEN=1, write) `test/golden/<name>.json`. */
export function matchGolden(name: string, value: unknown): { expected: unknown; actual: unknown } {
  const file = path.join(GOLDEN, `${name}.json`);
  const actual = JSON.parse(JSON.stringify(value)) as unknown;
  if (process.env.UPDATE_GOLDEN === "1" || !fs.existsSync(file)) {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
  }
  return { expected: JSON.parse(fs.readFileSync(file, "utf8")) as unknown, actual };
}

export const BUILD_TIMEOUT = 180_000;
