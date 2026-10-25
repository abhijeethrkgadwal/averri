/** Test helpers: fixtures are copied under `packages/cli/test/.tmp/` (gitignored) so module resolution walks up to the monorepo's node_modules. */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { run, type Io, type RunOptions } from "../src/index.js";

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TMP = path.join(TEST_DIR, ".tmp");

let counter = 0;

export function copyFixture(name: string): { root: string; cleanup(): void } {
  fs.mkdirSync(TMP, { recursive: true });
  const root = path.join(TMP, `${name}-${process.pid}-${Date.now().toString(36)}-${counter++}`);
  fs.cpSync(path.join(TEST_DIR, "fixtures", name), root, { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function emptyDir(label: string): { root: string; cleanup(): void } {
  fs.mkdirSync(TMP, { recursive: true });
  const root = path.join(TMP, `${label}-${process.pid}-${Date.now().toString(36)}-${counter++}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  json<T = any>(): T;
}

export async function cli(root: string, args: string[], options: RunOptions = {}, stdin = ""): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const io: Io = { cwd: root, stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t), stdin: async () => stdin, color: false };
  const code = await run(args, io, options);
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

/** Replace build-specific values so JSON can be snapshotted. */
export function normalize(value: unknown, root: string): unknown {
  const text = JSON.stringify(value)
    .split(JSON.stringify(root).slice(1, -1))
    .join("<root>");
  return JSON.parse(text, (k, v) => (k === "builtAt" ? "<builtAt>" : k === "contentHash" ? "<hash>" : k === "commit" ? null : v));
}
