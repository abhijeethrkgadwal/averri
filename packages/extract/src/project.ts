/**
 * Input discovery and the ts-morph project the TypeScript extractors share.
 *
 * Files are discovered with fast-glob from the repo root: every `.ts/.tsx/.mts/.cts` under the source
 * roots, hand-written test files anywhere under the root (minus `generatedDir`), the entry points, the
 * Averri config module, `package.json` and the Prisma schema. `node_modules`, `dist`, `.averri` and
 * `.d.ts` files are never inputs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import { Project, ts, type SourceFile } from "ts-morph";
import type { ExtractOptions, ExtractWarning, InputFile } from "./types.js";
import { EXTRACT_DEFAULTS } from "./types.js";
import { absPath, compareStrings, relPath, sha256, toPosix, uniq } from "./util.js";

export interface ResolvedOptions {
  sourceRoots: string[];
  prismaSchema: string | null;
  entryPoints: string[] | null;
  publicMarker: string | null;
  generatedDir: string;
  testGlobs: string[];
  tsConfigPath: string | null;
  configFile: string | null;
  include: Record<"prisma" | "routes" | "zod" | "tests" | "modules", boolean>;
}

export interface ProjectContext {
  rootDir: string;
  options: ResolvedOptions;
  project: Project;
  /** Repo-relative paths of TypeScript files under the source roots (sorted). */
  sourceFiles: string[];
  /** Repo-relative paths of hand-written test files (sorted). */
  testFiles: string[];
  /** Repo-relative paths of the TS files the extractors visit: sources + tests + entry points + config. */
  tsFiles: string[];
  prismaSchemaFile: string | null;
  packageJsonFile: string | null;
  warnings: ExtractWarning[];
  /** Repo-relative POSIX path of a ts-morph source file. */
  rel(sf: SourceFile): string;
  /** Source file for a repo-relative path, when loaded. */
  sourceFile(rel: string): SourceFile | undefined;
}

const IGNORE = ["**/node_modules/**", "**/dist/**", "**/.averri/**", "**/*.d.ts"];

export function resolveOptions(rootDir: string, options: ExtractOptions = {}): ResolvedOptions {
  const include = { prisma: true, routes: true, zod: true, tests: true, modules: true, ...(options.include ?? {}) };
  let tsConfigPath: string | null = null;
  if (options.tsConfigPath !== undefined) tsConfigPath = options.tsConfigPath;
  else if (fs.existsSync(path.join(rootDir, "tsconfig.json"))) tsConfigPath = "tsconfig.json";
  let configFile: string | null = null;
  if (options.configFile !== undefined) configFile = options.configFile;
  else configFile = EXTRACT_DEFAULTS.configFiles.find((f) => fs.existsSync(path.join(rootDir, f))) ?? null;
  return {
    sourceRoots: (options.sourceRoots ?? [...EXTRACT_DEFAULTS.sourceRoots]).map(normalizeDir),
    prismaSchema: options.prismaSchema === undefined ? EXTRACT_DEFAULTS.prismaSchema : options.prismaSchema,
    entryPoints: options.entryPoints ? options.entryPoints.map(normalizeDir) : null,
    publicMarker: options.publicMarker ?? null,
    generatedDir: normalizeDir(options.generatedDir ?? EXTRACT_DEFAULTS.generatedDir),
    testGlobs: options.testGlobs ?? [...EXTRACT_DEFAULTS.testGlobs],
    tsConfigPath,
    configFile,
    include,
  };
}

function normalizeDir(p: string): string {
  let n = toPosix(p).trim();
  if (n.startsWith("./")) n = n.slice(2);
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}

export function loadProject(rootDir: string, options: ExtractOptions = {}): ProjectContext {
  const root = path.resolve(rootDir);
  const resolved = resolveOptions(root, options);
  const warnings: ExtractWarning[] = [];

  const sourceSet = new Set<string>();
  for (const sr of resolved.sourceRoots) {
    const dir = path.join(root, sr);
    if (!fs.existsSync(dir)) {
      warnings.push({ code: "source-root-missing", message: `source root ${sr} does not exist`, file: sr });
      continue;
    }
    for (const f of fg.sync(`${sr}/**/*.{ts,tsx,mts,cts}`, { cwd: root, ignore: IGNORE, onlyFiles: true, dot: false })) {
      sourceSet.add(toPosix(f));
    }
  }
  const genPrefix = `${resolved.generatedDir}/`;
  const testSet = new Set<string>();
  for (const f of fg.sync(resolved.testGlobs, { cwd: root, ignore: IGNORE, onlyFiles: true, dot: false })) {
    const p = toPosix(f);
    if (p.startsWith(genPrefix)) continue;
    testSet.add(p);
  }
  for (const f of sourceSet) if (testSet.has(f)) sourceSet.delete(f);

  const sourceFiles = [...sourceSet].sort(compareStrings);
  const testFiles = [...testSet].sort(compareStrings);
  const extra: string[] = [];
  if (resolved.entryPoints) {
    for (const ep of resolved.entryPoints) {
      if (!fs.existsSync(path.join(root, ep))) {
        warnings.push({ code: "entry-point-missing", message: `entry point ${ep} does not exist`, file: ep });
        continue;
      }
      extra.push(ep);
    }
  }
  if (resolved.configFile && fs.existsSync(path.join(root, resolved.configFile))) extra.push(resolved.configFile);
  const tsFiles = uniq([...sourceFiles, ...testFiles, ...extra.filter((f) => /\.[cm]?tsx?$/.test(f))]).sort(compareStrings);

  const tsConfigAbs = resolved.tsConfigPath ? absPath(root, resolved.tsConfigPath) : null;
  const project =
    tsConfigAbs && fs.existsSync(tsConfigAbs)
      ? new Project({ tsConfigFilePath: tsConfigAbs, skipAddingFilesFromTsConfig: true, skipLoadingLibFiles: false })
      : new Project({
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: false,
            skipLibCheck: true,
            allowJs: true,
            esModuleInterop: true,
            noEmit: true,
          },
          skipLoadingLibFiles: false,
        });
  for (const f of tsFiles) project.addSourceFileAtPath(path.join(root, f));

  const prismaSchemaFile =
    resolved.prismaSchema && fs.existsSync(path.join(root, resolved.prismaSchema)) ? resolved.prismaSchema : null;
  const packageJsonFile = fs.existsSync(path.join(root, "package.json")) ? "package.json" : null;

  return {
    rootDir: root,
    options: resolved,
    project,
    sourceFiles,
    testFiles,
    tsFiles,
    prismaSchemaFile,
    packageJsonFile,
    warnings,
    rel: (sf) => relPath(root, sf.getFilePath()),
    sourceFile: (rel) => project.getSourceFile(path.join(root, rel)),
  };
}

/** Every file that feeds `contentHash` (SPEC-IR §6): sources, schema, package.json, config, hand-written tests. */
export function collectInputFiles(ctx: ProjectContext): InputFile[] {
  const paths = new Set<string>(ctx.tsFiles);
  if (ctx.prismaSchemaFile) paths.add(ctx.prismaSchemaFile);
  if (ctx.packageJsonFile) paths.add(ctx.packageJsonFile);
  if (ctx.options.configFile && fs.existsSync(path.join(ctx.rootDir, ctx.options.configFile))) paths.add(ctx.options.configFile);
  const out: InputFile[] = [];
  for (const p of [...paths].sort(compareStrings)) {
    const abs = path.join(ctx.rootDir, p);
    if (!fs.existsSync(abs)) continue;
    out.push({ path: p, hash: sha256(fs.readFileSync(abs)) });
  }
  return out;
}

/** sha256 over the sorted `(path, hash)` list; independent of discovery order. */
export function contentHashOf(files: readonly InputFile[]): string {
  const sorted = [...files].sort((a, b) => compareStrings(a.path, b.path));
  return sha256(sorted.map((f) => `${f.path}\u0000${f.hash}`).join("\n"));
}
