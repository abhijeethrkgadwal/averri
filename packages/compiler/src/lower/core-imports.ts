/**
 * Recognition of `@averri/core` bindings in a source file: the seven constructors and the two
 * builders, through named imports (aliased or not), namespace imports and local `const` aliases
 * (`const E = e`). Purely syntactic; the module is never loaded.
 */

import { Node, type SourceFile } from "ts-morph";
import { unwrapExpr } from "./literal.js";

export const CONSTRUCTS = ["entity", "policy", "action", "query", "event", "workflow", "integration"] as const;
export type Construct = (typeof CONSTRUCTS)[number];
export const CORE_MODULE = "@averri/core";

export interface CoreBindings {
  /** local name -> construct */
  constructs: Map<string, Construct>;
  /** local names bound to `e` */
  e: Set<string>;
  /** local names bound to `db` */
  db: Set<string>;
  /** namespace import names (`import * as averri from "@averri/core"`) */
  namespaces: Set<string>;
}

const cache = new WeakMap<SourceFile, CoreBindings>();

export function coreBindings(sf: SourceFile): CoreBindings {
  const hit = cache.get(sf);
  if (hit) return hit;
  const b: CoreBindings = { constructs: new Map(), e: new Set(), db: new Set(), namespaces: new Set() };
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== CORE_MODULE) continue;
    if (imp.isTypeOnly()) continue;
    const ns = imp.getNamespaceImport();
    if (ns) b.namespaces.add(ns.getText());
    for (const spec of imp.getNamedImports()) {
      if (spec.isTypeOnly()) continue;
      const imported = spec.getNameNode().getText();
      const local = spec.getAliasNode()?.getText() ?? imported;
      if ((CONSTRUCTS as readonly string[]).includes(imported)) b.constructs.set(local, imported as Construct);
      else if (imported === "e") b.e.add(local);
      else if (imported === "db") b.db.add(local);
    }
  }
  // local const aliases: `const E = e;`
  for (const vd of sf.getVariableDeclarations()) {
    const init = vd.getInitializer();
    if (!init) continue;
    const u = unwrapExpr(init);
    const name = vd.getName();
    if (Node.isIdentifier(u)) {
      if (b.e.has(u.getText())) b.e.add(name);
      else if (b.db.has(u.getText())) b.db.add(name);
      else {
        const c = b.constructs.get(u.getText());
        if (c) b.constructs.set(name, c);
      }
    } else if (Node.isPropertyAccessExpression(u) && Node.isIdentifier(u.getExpression()) && b.namespaces.has(u.getExpression().getText())) {
      const member = u.getName();
      if (member === "e") b.e.add(name);
      else if (member === "db") b.db.add(name);
      else if ((CONSTRUCTS as readonly string[]).includes(member)) b.constructs.set(name, member as Construct);
    }
  }
  cache.set(sf, b);
  return b;
}

export function importsCore(sf: SourceFile): boolean {
  const b = coreBindings(sf);
  return b.constructs.size > 0 || b.e.size > 0 || b.db.size > 0 || b.namespaces.size > 0;
}

/** The construct a call's callee denotes, or null. */
export function constructOfCallee(callee: Node, b: CoreBindings): Construct | null {
  const c = unwrapExpr(callee);
  if (Node.isIdentifier(c)) return b.constructs.get(c.getText()) ?? null;
  if (Node.isPropertyAccessExpression(c)) {
    const obj = unwrapExpr(c.getExpression());
    if (Node.isIdentifier(obj) && b.namespaces.has(obj.getText()) && (CONSTRUCTS as readonly string[]).includes(c.getName())) {
      return c.getName() as Construct;
    }
  }
  return null;
}

/** `"e"`, `"db"` or null for the receiver of a builder call (`e.eq` -> receiver `e`). */
export function builderOf(receiver: Node, b: CoreBindings): "e" | "db" | null {
  const r = unwrapExpr(receiver);
  if (Node.isIdentifier(r)) {
    if (b.e.has(r.getText())) return "e";
    if (b.db.has(r.getText())) return "db";
    return null;
  }
  if (Node.isPropertyAccessExpression(r)) {
    const obj = unwrapExpr(r.getExpression());
    if (Node.isIdentifier(obj) && b.namespaces.has(obj.getText())) {
      if (r.getName() === "e") return "e";
      if (r.getName() === "db") return "db";
    }
  }
  return null;
}
