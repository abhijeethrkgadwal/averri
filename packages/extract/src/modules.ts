/**
 * Module nodes: one per visited TypeScript file (the Prisma schema Module comes from the Prisma
 * extractor). `role` is decided from what the other extractors found in the file, with precedence
 * config > test > declaration > route > handler > other. `exports` are collected syntactically.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Node, type SourceFile } from "ts-morph";
import { moduleId, type ModuleNode, type ModuleRole } from "@averri/ir";
import type { ProjectContext } from "./project.js";
import { countLines, extracted, sha256, summary } from "./util.js";

export interface RoleHints {
  routeFiles: ReadonlySet<string>;
  handlerFiles: ReadonlySet<string>;
  testFiles: ReadonlySet<string>;
  configFile: string | null;
}

const DECLARATION_FNS = new Set(["entity", "policy", "action", "query", "event", "workflow", "integration"]);

export function extractModules(ctx: ProjectContext, hints: RoleHints, files: readonly string[] = ctx.tsFiles): ModuleNode[] {
  const nodes: ModuleNode[] = [];
  for (const rel of files) {
    const sf = ctx.sourceFile(rel);
    const text = sf ? sf.getFullText() : fs.readFileSync(path.join(ctx.rootDir, rel), "utf8");
    const role = roleOf(rel, sf, hints);
    const exports = sf ? exportNames(sf) : [];
    nodes.push({
      id: moduleId(rel),
      kind: "Module",
      name: rel,
      summary: summary(`${role} module ${rel} · ${countLines(text)} lines${exports.length ? ` · exports ${exports.slice(0, 8).join(", ")}${exports.length > 8 ? ", ..." : ""}` : ""}`),
      provenance: extracted("ts-handler", 1, [{ kind: "source", note: `${rel} read at build time (${role})` }]),
      src: null,
      file: rel,
      role,
      exports,
      hash: sha256(text),
      lines: countLines(text),
    });
  }
  return nodes;
}

export function roleOf(rel: string, sf: SourceFile | undefined, hints: RoleHints): ModuleRole {
  if (hints.configFile && rel === hints.configFile) return "config";
  if (/^averri\.config\.[cm]?[jt]s$/.test(rel)) return "config";
  if (hints.testFiles.has(rel)) return "test";
  if (sf && isDeclarationModule(sf)) return "declaration";
  if (hints.routeFiles.has(rel)) return "route";
  if (hints.handlerFiles.has(rel)) return "handler";
  return "other";
}

/** Imports `@averri/core` and calls one of its seven constructors. */
export function isDeclarationModule(sf: SourceFile): boolean {
  const importsCore = sf.getImportDeclarations().some((d) => d.getModuleSpecifierValue() === "@averri/core");
  if (!importsCore) return false;
  let found = false;
  sf.forEachDescendant((n, traversal) => {
    if (found) return traversal.stop();
    if (Node.isCallExpression(n)) {
      const callee = n.getExpression();
      if (Node.isIdentifier(callee) && DECLARATION_FNS.has(callee.getText())) {
        found = true;
        traversal.stop();
      }
    }
    return undefined;
  });
  return found;
}

/** Exported names, syntactically: `export const/function/class/enum/type/interface`, `export default`, `export { a, b as c }`. */
export function exportNames(sf: SourceFile): string[] {
  const names: string[] = [];
  const push = (n: string) => {
    if (!names.includes(n)) names.push(n);
  };
  for (const stmt of sf.getStatements()) {
    if (Node.isExportAssignment(stmt)) {
      push("default");
      continue;
    }
    if (Node.isExportDeclaration(stmt)) {
      if (stmt.isNamespaceExport()) {
        const alias = stmt.getNamespaceExport()?.getName();
        push(alias ?? "*");
        continue;
      }
      for (const spec of stmt.getNamedExports()) push(spec.getAliasNode()?.getText() ?? spec.getNameNode().getText());
      continue;
    }
    if (!Node.isExportable(stmt) || !stmt.hasExportKeyword()) continue;
    if (stmt.hasDefaultKeyword()) push("default");
    if (Node.isVariableStatement(stmt)) {
      for (const d of stmt.getDeclarations()) for (const n of bindingNames(d.getNameNode())) push(n);
      continue;
    }
    if (stmt.hasDefaultKeyword()) continue;
    if (
      Node.isFunctionDeclaration(stmt) ||
      Node.isClassDeclaration(stmt) ||
      Node.isEnumDeclaration(stmt) ||
      Node.isInterfaceDeclaration(stmt) ||
      Node.isTypeAliasDeclaration(stmt) ||
      Node.isModuleDeclaration(stmt)
    ) {
      const n = stmt.getName();
      if (n) push(n);
    }
  }
  return names;
}

/** Names bound by a declaration name node, including destructuring patterns. */
function bindingNames(nameNode: Node): string[] {
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()];
  if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
    return nameNode.getElements().flatMap((el) => (Node.isBindingElement(el) ? bindingNames(el.getNameNode()) : []));
  }
  return [];
}
