/**
 * Static symbol resolution helpers on top of ts-morph: unwrap expressions, follow identifiers to
 * their declaring node across imports/re-exports, evaluate constant strings, and build `SymbolRef`s.
 */

import { Node, SyntaxKind, type Expression, type SourceFile, type Symbol as TsSymbol } from "ts-morph";
import type { SymbolRef } from "@averri/ir";
import { compactText, rangeOf, relPath } from "./util.js";

/** Strip parentheses, `as`, `satisfies`, `!` and `<T>` assertions. */
export function unwrap(expr: Node): Node {
  let cur: Node = expr;
  for (;;) {
    if (Node.isParenthesizedExpression(cur)) cur = cur.getExpression();
    else if (Node.isAsExpression(cur)) cur = cur.getExpression();
    else if (Node.isSatisfiesExpression(cur)) cur = cur.getExpression();
    else if (Node.isNonNullExpression(cur)) cur = cur.getExpression();
    else if (Node.isTypeAssertion(cur)) cur = cur.getExpression();
    else if (Node.isAwaitExpression(cur)) cur = cur.getExpression();
    else return cur;
  }
}

/** The declaring node of a symbol, following import/export aliases. Returns undefined when unresolvable. */
export function declarationOfSymbol(symbol: TsSymbol | undefined, depth = 0): Node | undefined {
  if (!symbol || depth > 10) return undefined;
  const aliased = symbol.getAliasedSymbol();
  if (aliased && aliased !== symbol) return declarationOfSymbol(aliased, depth + 1);
  const decls = symbol.getDeclarations();
  for (const d of decls) {
    if (Node.isImportSpecifier(d) || Node.isImportClause(d) || Node.isNamespaceImport(d) || Node.isExportSpecifier(d)) {
      const next = declarationOfSymbol(d.getSymbol()?.getAliasedSymbol(), depth + 1);
      if (next) return next;
      continue;
    }
    return d;
  }
  return decls[0];
}

/**
 * Declaration of an identifier (or the root identifier of a property access), following aliases and
 * `export default <identifier>` assignments. `ExportAssignment` with a non-identifier expression is
 * returned as is (its expression is the value).
 */
export function resolveDeclaration(expr: Node, depth = 0): Node | undefined {
  if (depth > 10) return undefined;
  const e = unwrap(expr);
  if (Node.isIdentifier(e)) {
    const decl = declarationOfSymbol(e.getSymbol(), depth);
    if (!decl) return undefined;
    if (Node.isExportAssignment(decl)) {
      const inner = unwrap(decl.getExpression());
      if (Node.isIdentifier(inner) || Node.isPropertyAccessExpression(inner)) return resolveDeclaration(inner, depth + 1);
      return decl;
    }
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init) {
        const u = unwrap(init);
        if (Node.isIdentifier(u) && u.getText() !== decl.getName()) {
          const next = resolveDeclaration(u, depth + 1);
          if (next) return next;
        }
      }
    }
    return decl;
  }
  if (Node.isPropertyAccessExpression(e)) {
    // `ns.member` through a namespace import or an object literal: resolve the member symbol first.
    const sym = e.getNameNode().getSymbol();
    const decl = declarationOfSymbol(sym, depth);
    if (decl && !Node.isPropertySignature(decl)) {
      if (Node.isPropertyAssignment(decl)) {
        const init = decl.getInitializer();
        if (init) {
          const u = unwrap(init);
          if (Node.isIdentifier(u)) return resolveDeclaration(u, depth + 1) ?? decl;
        }
      }
      return decl;
    }
    return undefined;
  }
  return undefined;
}

/** Root identifier of a dotted access (`a.b.c` -> `a`), or the identifier itself. */
export function rootIdentifier(expr: Node): Node | undefined {
  let cur = unwrap(expr);
  while (Node.isPropertyAccessExpression(cur)) cur = unwrap(cur.getExpression());
  return Node.isIdentifier(cur) ? cur : undefined;
}

/** Module specifier of the import that binds `identifier`, when it is import-bound; null for local symbols. */
export function importSourceOf(identifier: Node): string | null {
  const id = unwrap(identifier);
  if (!Node.isIdentifier(id)) return null;
  const sym = id.getSymbol();
  if (!sym) return null;
  for (const d of sym.getDeclarations()) {
    if (Node.isImportSpecifier(d)) return d.getImportDeclaration().getModuleSpecifierValue();
    if (Node.isImportClause(d)) return d.getParentOrThrow().asKindOrThrow(SyntaxKind.ImportDeclaration).getModuleSpecifierValue();
    if (Node.isNamespaceImport(d)) return d.getParentOrThrow().getParentOrThrow().asKindOrThrow(SyntaxKind.ImportDeclaration).getModuleSpecifierValue();
    if (Node.isImportEqualsDeclaration(d)) {
      const ref = d.getModuleReference();
      if (Node.isExternalModuleReference(ref)) {
        const lit = ref.getExpression();
        if (lit && Node.isStringLiteral(lit)) return lit.getLiteralText();
      }
    }
  }
  return null;
}

/**
 * Statically evaluate a string: string literal, template without substitutions, template whose
 * substitutions evaluate statically, `"a" + "b"`, or an identifier bound to a `const` with such an
 * initializer (followed up to depth 3). Returns null when not decidable.
 */
export function staticString(expr: Node, depth = 0): string | null {
  const e = unwrap(expr);
  if (Node.isStringLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e)) return e.getLiteralText();
  if (Node.isTemplateExpression(e)) {
    let out = e.getHead().getLiteralText();
    for (const span of e.getTemplateSpans()) {
      const v = staticString(span.getExpression(), depth + 1);
      if (v === null) return null;
      out += v + span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const l = staticString(e.getLeft(), depth + 1);
    const r = staticString(e.getRight(), depth + 1);
    return l !== null && r !== null ? l + r : null;
  }
  if (depth >= 3) return null;
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    const decl = resolveDeclaration(e, depth);
    if (decl && Node.isVariableDeclaration(decl)) {
      const stmt = decl.getVariableStatement();
      if (stmt && stmt.getDeclarationKind() !== "const") return null;
      const init = decl.getInitializer();
      return init ? staticString(init, depth + 1) : null;
    }
    if (decl && Node.isPropertyAssignment(decl)) {
      const init = decl.getInitializer();
      return init ? staticString(init, depth + 1) : null;
    }
    if (decl && Node.isEnumMember(decl)) {
      const v = decl.getValue();
      return typeof v === "string" ? v : null;
    }
  }
  return null;
}

/** Elements of a static string array literal (`["a", "b"]`), or null. */
export function staticStringArray(expr: Node, depth = 0): string[] | null {
  const e = unwrap(expr);
  if (Node.isArrayLiteralExpression(e)) {
    const out: string[] = [];
    for (const el of e.getElements()) {
      const v = staticString(el, depth);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  }
  if (depth < 3 && (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e))) {
    const decl = resolveDeclaration(e, depth);
    if (decl && Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      return init ? staticStringArray(init, depth + 1) : null;
    }
  }
  return null;
}

/** Name of a variable/function/class/parameter declaration, or null. */
export function declarationName(decl: Node): string | null {
  if (Node.isVariableDeclaration(decl) || Node.isFunctionDeclaration(decl) || Node.isClassDeclaration(decl) || Node.isParameterDeclaration(decl)) {
    return decl.getName() ?? null;
  }
  if (Node.isPropertyAssignment(decl) || Node.isShorthandPropertyAssignment(decl) || Node.isMethodDeclaration(decl) || Node.isPropertyDeclaration(decl)) {
    return decl.getName();
  }
  if (Node.isExportAssignment(decl)) return "default";
  return null;
}

/**
 * A `SymbolRef` for a handler/schema expression: identifiers and dotted accesses resolve to the file
 * that declares the root symbol (`{ file, symbol: "listRoutes.inviteMember" }`); inline functions
 * become `(anonymous)` with a range; anything else keeps its compact text as the symbol.
 */
export function symbolRefOf(expr: Node, rootDir: string, currentFile: string): SymbolRef {
  const e = unwrap(expr);
  if (Node.isArrowFunction(e) || Node.isFunctionExpression(e)) {
    return { file: currentFile, symbol: "(anonymous)", range: rangeOf(currentFile, e) };
  }
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    const root = rootIdentifier(e);
    const decl = root ? resolveDeclaration(root) : undefined;
    const file = decl ? relPath(rootDir, decl.getSourceFile().getFilePath()) : currentFile;
    const symbol = Node.isIdentifier(e) && decl && Node.isExportAssignment(decl) ? "default" : compactText(e.getText());
    const ref: SymbolRef = { file, symbol };
    if (decl && !decl.getSourceFile().isFromExternalLibrary() && !decl.getSourceFile().isInNodeModules()) {
      ref.range = rangeOf(file, Node.isVariableDeclaration(decl) ? decl : decl);
    }
    return ref;
  }
  const text = compactText(e.getText());
  return { file: currentFile, symbol: text.length > 80 ? `${text.slice(0, 77)}...` : text, range: rangeOf(currentFile, e) };
}

/** True when `sf` imports something from a module whose specifier satisfies `pred`. */
export function importsFrom(sf: SourceFile, pred: (spec: string) => boolean): boolean {
  return sf.getImportDeclarations().some((d) => pred(d.getModuleSpecifierValue()));
}

/** Call-expression arguments as expressions. */
export function argsOf(call: Node): Expression[] {
  return Node.isCallExpression(call) || Node.isNewExpression(call) ? call.getArguments().map((a) => a as Expression) : [];
}
