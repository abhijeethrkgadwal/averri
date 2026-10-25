/**
 * tsc backstop runner: the project's own tsconfig (or strict defaults over the input files). Returns
 * flat, repo-relative errors for the collapser.
 *
 * The project's own `typescript` (resolved from its root) runs a plain `ts.createProgram`, so the
 * per-file module format under NodeNext comes from the nearest package.json `type` exactly as `tsc`
 * decides it and the lib files are the project's. Only when the project has no `typescript` does it
 * fall back to ts-morph's bundled compiler (in-memory lib files; a ts-morph Project does not apply
 * package.json `type`, so ESM-only syntax may be misreported there) (D-40).
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { DiagnosticCategory, Project, ts as bundledTs, type DiagnosticMessageChain } from "ts-morph";
import { readConfig } from "../config.js";
import { inputFiles } from "../inputs.js";
import { relPath } from "../util.js";

type Ts = typeof bundledTs;

export interface TscError {
  file: string | null;
  line: number;
  column: number;
  code: number;
  /** Full flattened message (chains joined with "\n", nested lines indented). */
  message: string;
}

function defaultOptions(ts: Ts): import("ts-morph").ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
  };
}

/** The project's `typescript` module, or null when it is not installed. */
function projectTypeScript(abs: string): Ts | null {
  try {
    return createRequire(path.join(abs, "package.json"))("typescript") as Ts;
  } catch {
    return null;
  }
}

function sourceFiles(abs: string): string[] {
  const { config } = readConfig(abs);
  return inputFiles(abs, config)
    .filter((f) => /\.[cm]?tsx?$/.test(f.path))
    .map((f) => path.join(abs, f.path));
}

function flattenChain(m: string | import("ts-morph").ts.DiagnosticMessageChain, indent = 0): string {
  if (typeof m === "string") return m;
  const head = `${"  ".repeat(indent)}${m.messageText}`;
  return [head, ...(m.next ?? []).map((n) => flattenChain(n, indent + 1))].join("\n");
}

function runWithProgram(ts: Ts, abs: string, tsconfig: string | null): TscError[] {
  let rootNames: string[];
  let options: import("ts-morph").ts.CompilerOptions;
  if (tsconfig !== null) {
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    if (parsed === undefined) return [{ file: "tsconfig.json", line: 1, column: 0, code: 5083, message: "Cannot read tsconfig.json" }];
    rootNames = parsed.fileNames;
    options = { ...parsed.options, noEmit: true };
  } else {
    rootNames = sourceFiles(abs);
    options = defaultOptions(ts);
  }
  const program = ts.createProgram({ rootNames, options });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => {
      const message = flattenChain(d.messageText);
      if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        return { file: relPath(abs, d.file.fileName), line: line + 1, column: character, code: d.code, message };
      }
      return { file: null, line: 0, column: 0, code: d.code, message };
    });
}

function flatten(m: string | DiagnosticMessageChain, indent = 0): string {
  if (typeof m === "string") return m;
  const head = `${"  ".repeat(indent)}${m.getMessageText()}`;
  const next = m.getNext() ?? [];
  return [head, ...next.map((n) => flatten(n, indent + 1))].join("\n");
}

function runWithTsMorph(abs: string, tsconfig: string | null): TscError[] {
  let project: Project;
  if (tsconfig !== null) {
    project = new Project({ tsConfigFilePath: tsconfig, compilerOptions: { noEmit: true } });
  } else {
    project = new Project({ compilerOptions: defaultOptions(bundledTs) });
    for (const f of sourceFiles(abs)) project.addSourceFileAtPath(f);
  }
  return project
    .getPreEmitDiagnostics()
    .filter((d) => d.getCategory() === DiagnosticCategory.Error)
    .map((d) => {
      const message = flatten(d.getMessageText());
      const sf = d.getSourceFile();
      const start = d.getStart();
      if (sf && start !== undefined) {
        const { line, column } = sf.getLineAndColumnAtPos(start);
        return { file: relPath(abs, sf.getFilePath()), line, column: column - 1, code: d.getCode(), message };
      }
      return { file: null, line: 0, column: 0, code: d.getCode(), message };
    });
}

export function runTsc(root: string): TscError[] {
  const abs = path.resolve(root);
  const tsconfigPath = path.join(abs, "tsconfig.json");
  const tsconfig = fs.existsSync(tsconfigPath) ? tsconfigPath : null;
  const ts = projectTypeScript(abs);
  return ts !== null ? runWithProgram(ts, abs, tsconfig) : runWithTsMorph(abs, tsconfig);
}
