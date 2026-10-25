/**
 * Import-closure test selection for `check --scope affected` (SPEC-MCP §6.5, "plus any test touching
 * changed files"). Hand-written tests rarely carry `// @averri covers` headers, so a test is selected
 * when any file it imports, transitively, is a changed file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import { toPosix } from "../util.js";

function createProject(root: string): Project {
  const tsconfig = path.join(root, "tsconfig.json");
  if (fs.existsSync(tsconfig)) {
    return new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  }
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
  });
}

/**
 * Repo-relative files reachable from `entry` through static `import`/`export ... from` and
 * `import("...")`/`require("...")` string literals, excluding `node_modules` and files outside `root`.
 * Includes `entry` itself.
 */
export function importClosure(project: Project, root: string, entry: string, cache: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [entry];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    let deps = cache.get(rel);
    if (deps === undefined) {
      deps = directImports(project, root, rel);
      cache.set(rel, deps);
    }
    for (const dep of deps) if (!seen.has(dep)) stack.push(dep);
  }
  return seen;
}

function relativeTo(root: string, sf: SourceFile): string | null {
  const file = sf.getFilePath();
  if (file.includes("/node_modules/")) return null;
  const rel = toPosix(path.relative(root, file));
  return rel.startsWith("..") ? null : rel;
}

function directImports(project: Project, root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  let sf = project.getSourceFile(abs);
  if (!sf) {
    if (!fs.existsSync(abs)) return [];
    try {
      sf = project.addSourceFileAtPath(abs);
    } catch {
      return [];
    }
  }
  const out = new Set<string>();
  const add = (dep: SourceFile | undefined): void => {
    if (!dep) return;
    const r = relativeTo(root, dep);
    if (r !== null) out.add(r);
  };
  for (const d of sf.getImportDeclarations()) add(d.getModuleSpecifierSourceFile());
  for (const d of sf.getExportDeclarations()) add(d.getModuleSpecifierSourceFile());
  sf.forEachDescendant((node) => {
    if (node.getKind() !== ts.SyntaxKind.CallExpression) return;
    const call = node.asKindOrThrow(ts.SyntaxKind.CallExpression);
    const callee = call.getExpression().getText();
    if (callee !== "require" && callee !== "import") return;
    const arg = call.getArguments()[0];
    if (!arg || arg.getKind() !== ts.SyntaxKind.StringLiteral) return;
    const spec = arg.asKindOrThrow(ts.SyntaxKind.StringLiteral).getLiteralText();
    if (!spec.startsWith(".")) return;
    const base = path.resolve(path.dirname(abs), spec.replace(/\.[cm]?js$/, ""));
    for (const ext of [".ts", ".tsx", ".mts", ".cts", "/index.ts"]) {
      if (fs.existsSync(base + ext)) {
        out.add(toPosix(path.relative(root, base + ext)));
        break;
      }
    }
  });
  return [...out].sort();
}

/** The subset of `testFiles` whose import closure contains a file in `changed`. Deterministic order. */
export function testFilesReaching(root: string, testFiles: readonly string[], changed: ReadonlySet<string>): string[] {
  if (changed.size === 0) return [];
  const project = createProject(root);
  const cache = new Map<string, string[]>();
  const out: string[] = [];
  for (const file of testFiles) {
    const closure = importClosure(project, root, file, cache);
    for (const c of closure) {
      if (changed.has(c)) {
        out.push(file);
        break;
      }
    }
  }
  return out;
}
