/**
 * Zod schema reference extraction.
 *
 * Finds variable declarations (and one level of object-literal members, `InviteMember.input`) whose
 * initializer is a Zod chain rooted at `z.<fn>(...)` or at another Zod schema, and derives the
 * top-level field names of object schemas:
 *
 * - AST first: `z.object({ ... })` keys, then `.extend({...})` adds, `.merge(Other)` adds the
 *   other's keys, `.pick({a: true})` keeps, `.omit({a: true})` removes; `.partial()/.strict()/...`
 *   pass through. A spread or a non-literal argument makes the shape incomplete.
 * - TypeChecker fallback: when the AST is incomplete or the root is not a literal, the properties of
 *   the declaration type's `shape` member are used (`method: "checker"`).
 *
 * Zod schemas have no node kind; facts go to `ExtractResult.zodSchemas` and feed Exposure.bodySchema
 * (`validatesWith` edges) and the compiler's `zod-match`.
 */

import { Node, type CallExpression, type Expression, type SourceFile } from "ts-morph";
import type { Evidence, SymbolRef } from "@averri/ir";
import type { ProjectContext } from "./project.js";
import { importSourceOf, resolveDeclaration, rootIdentifier, unwrap } from "./resolve.js";
import type { ExtractWarning, ZodSchemaFact } from "./types.js";
import { rangeOf } from "./util.js";

export const ZOD_CONFIDENCE = { complete: 0.98, incomplete: 0.7 } as const;

const OBJECT_ROOTS = new Set(["object", "strictObject", "looseObject", "interface"]);
const PASS_THROUGH = new Set([
  "partial",
  "required",
  "strict",
  "strip",
  "passthrough",
  "optional",
  "nullable",
  "nullish",
  "default",
  "describe",
  "refine",
  "superRefine",
  "check",
  "transform",
  "pipe",
  "brand",
  "readonly",
  "catch",
  "meta",
  "openapi",
  "overwrite",
  "register",
]);

export interface ZodIndex {
  facts: ZodSchemaFact[];
  warnings: ExtractWarning[];
  /** Declaration node -> fact, for resolving references from route files. */
  byDeclaration: Map<Node, ZodSchemaFact>;
}

interface Shape {
  fields: string[];
  complete: boolean;
  /** True when the chain root is an object schema (`z.object`/`extend`/`merge` of one). */
  object: boolean;
}

export function extractZodSchemas(ctx: ProjectContext, files: readonly string[] = ctx.tsFiles): ZodIndex {
  const index: ZodIndex = { facts: [], warnings: [], byDeclaration: new Map() };
  const cache = new Map<Node, Shape | null>();
  for (const rel of files) {
    const sf = ctx.sourceFile(rel);
    if (!sf) continue;
    const exportedNames = exportedNamesOf(sf);
    for (const decl of sf.getVariableDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      const name = decl.getName();
      const exported = decl.getVariableStatement()?.isExported() === true || exportedNames.has(name);
      if (isZodChain(init)) {
        addFact(decl, init, name, exported);
        continue;
      }
      const obj = unwrap(init);
      if (Node.isObjectLiteralExpression(obj)) {
        for (const prop of obj.getProperties()) {
          if (!Node.isPropertyAssignment(prop)) continue;
          const pinit = prop.getInitializer();
          if (!pinit || !isZodChain(pinit)) continue;
          addFact(prop, pinit, `${name}.${prop.getName()}`, exported);
        }
      }
    }
  }
  index.facts.sort((a, b) => (a.ref.file < b.ref.file ? -1 : a.ref.file > b.ref.file ? 1 : a.ref.symbol < b.ref.symbol ? -1 : a.ref.symbol > b.ref.symbol ? 1 : 0));
  return index;

  function addFact(declNode: Node, init: Expression, symbol: string, exported: boolean): void {
    const sf = declNode.getSourceFile();
    const file = ctx.rel(sf);
    let shape = shapeOf(init, cache);
    let method: ZodSchemaFact["method"] = "ast";
    if (!shape || !shape.complete) {
      const checked = checkerShape(declNode);
      if (checked) {
        shape = { fields: checked, complete: true, object: true };
        method = "checker";
      }
    }
    const fields = shape?.fields ?? [];
    const complete = shape?.complete ?? false;
    const src = rangeOf(file, declNode);
    const evidence: Evidence[] = [
      {
        kind: "schema",
        note: `${symbol}: zod ${shape?.object ? "object" : "schema"} with ${fields.length} field${fields.length === 1 ? "" : "s"} at ${file}:${src.range[0][0]}${method === "checker" ? " (shape from TypeChecker)" : ""}`,
        src,
      },
    ];
    if (!complete) {
      index.warnings.push({
        code: "zod-shape-unresolved",
        message: `${symbol}: the Zod object shape could not be fully decided statically (${fields.length} fields known)`,
        file,
        src,
      });
    }
    const ref: SymbolRef = { file, symbol, range: src };
    const fact: ZodSchemaFact = { ref, exported, fields, complete, method, evidence };
    index.facts.push(fact);
    index.byDeclaration.set(declNode, fact);
  }
}

/** Names exported through `export { a, b }` lists. */
function exportedNamesOf(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const ed of sf.getExportDeclarations()) {
    if (ed.getModuleSpecifier()) continue;
    for (const spec of ed.getNamedExports()) names.add(spec.getNameNode().getText());
  }
  return names;
}

/** True when `expr` is a call chain whose root is `z.<fn>(...)` from zod or another Zod schema symbol. */
export function isZodChain(expr: Node): boolean {
  return zodRoot(expr) !== null;
}

type ZodRoot = { kind: "z"; fn: string; call: CallExpression } | { kind: "ref"; decl: Node };

/** The innermost element of a Zod chain: `z.object(...)` or a reference to another schema declaration. */
function zodRoot(expr: Node, depth = 0): ZodRoot | null {
  if (depth > 20) return null;
  const e = unwrap(expr);
  if (Node.isCallExpression(e)) {
    const callee = unwrap(e.getExpression());
    if (Node.isPropertyAccessExpression(callee)) {
      const receiver = unwrap(callee.getExpression());
      const fn = callee.getName();
      if (Node.isIdentifier(receiver) && isZodNamespace(receiver)) return { kind: "z", fn, call: e };
      if (Node.isPropertyAccessExpression(receiver)) {
        // `z.coerce.number()` / `z.iso.date()`
        const r2 = rootIdentifier(receiver);
        if (r2 && isZodNamespace(r2) && Node.isIdentifier(unwrap(receiver.getExpression()))) return { kind: "z", fn, call: e };
      }
      return zodRoot(receiver, depth + 1);
    }
    return null;
  }
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    const decl = resolveDeclaration(e);
    if (!decl) return null;
    const init = Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl) ? decl.getInitializer() : undefined;
    if (init && zodRoot(init, depth + 1)) return { kind: "ref", decl };
    if (decl.getSourceFile().isInNodeModules()) return null;
    return null;
  }
  return null;
}

function isZodNamespace(id: Node): boolean {
  if (!Node.isIdentifier(id)) return false;
  const spec = importSourceOf(id);
  if (spec !== null) return spec === "zod" || spec.startsWith("zod/") || spec.includes("zod");
  return id.getText() === "z";
}

/** Top-level fields of an object schema chain. Null when the chain is not an object schema. */
function shapeOf(expr: Node, cache: Map<Node, Shape | null>, depth = 0): Shape | null {
  const e = unwrap(expr);
  if (cache.has(e)) return cache.get(e) ?? null;
  if (depth > 20) return null;
  cache.set(e, null);
  const result = computeShape(e, cache, depth);
  cache.set(e, result);
  return result;
}

function computeShape(e: Node, cache: Map<Node, Shape | null>, depth: number): Shape | null {
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    const decl = resolveDeclaration(e);
    const init = decl && (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl)) ? decl.getInitializer() : undefined;
    if (!init) return null;
    return shapeOf(init, cache, depth + 1);
  }
  if (!Node.isCallExpression(e)) return null;
  const callee = unwrap(e.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const fn = callee.getName();
  const receiver = unwrap(callee.getExpression());
  const receiverIsZ = (Node.isIdentifier(receiver) && isZodNamespace(receiver)) || (Node.isPropertyAccessExpression(receiver) && rootIsZ(receiver));
  const args = e.getArguments();

  if (receiverIsZ) {
    if (OBJECT_ROOTS.has(fn)) {
      const first = args[0];
      if (!first) return { fields: [], complete: false, object: true };
      return literalKeys(first);
    }
    return { fields: [], complete: true, object: false };
  }

  const base = shapeOf(receiver, cache, depth + 1);
  if (!base) return null;
  if (PASS_THROUGH.has(fn)) return base;
  if (fn === "extend") {
    const first = args[0];
    if (!first) return base;
    const added = literalKeys(first);
    return { fields: merge(base.fields, added.fields), complete: base.complete && added.complete, object: true };
  }
  if (fn === "merge") {
    const first = args[0];
    const other = first ? shapeOf(first, cache, depth + 1) : null;
    if (!other) return { fields: base.fields, complete: false, object: true };
    return { fields: merge(base.fields, other.fields), complete: base.complete && other.complete, object: true };
  }
  if (fn === "pick" || fn === "omit") {
    const first = args[0];
    const keys = first ? literalKeys(first) : { fields: [], complete: false, object: true };
    const kept = fn === "pick" ? base.fields.filter((f) => keys.fields.includes(f)) : base.fields.filter((f) => !keys.fields.includes(f));
    return { fields: kept, complete: base.complete && keys.complete, object: true };
  }
  if (fn === "array" || fn === "or" || fn === "and" || fn === "record" || fn === "keyof") return { fields: [], complete: true, object: false };
  // Unknown method on an object schema: keep the keys but mark incomplete.
  return { fields: base.fields, complete: false, object: base.object };
}

function rootIsZ(pa: Node): boolean {
  const root = rootIdentifier(pa);
  return root !== undefined && isZodNamespace(root);
}

function literalKeys(expr: Node): Shape {
  const e = unwrap(expr);
  if (!Node.isObjectLiteralExpression(e)) {
    if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
      const decl = resolveDeclaration(e);
      const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
      if (init) return literalKeys(init);
    }
    return { fields: [], complete: false, object: true };
  }
  const fields: string[] = [];
  let complete = true;
  for (const prop of e.getProperties()) {
    if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop) || Node.isMethodDeclaration(prop)) {
      const nameNode = prop.getNameNode();
      if (Node.isComputedPropertyName(nameNode)) {
        complete = false;
        continue;
      }
      const name = Node.isStringLiteral(nameNode) || Node.isNumericLiteral(nameNode) ? nameNode.getLiteralText() : nameNode.getText();
      if (!fields.includes(name)) fields.push(name);
    } else {
      complete = false;
    }
  }
  return { fields, complete, object: true };
}

function merge(a: string[], b: string[]): string[] {
  const out = [...a];
  for (const k of b) if (!out.includes(k)) out.push(k);
  return out;
}

/** Field names from the TypeChecker: properties of the declaration type's `shape` member. */
function checkerShape(decl: Node): string[] | null {
  try {
    const type = decl.getType();
    const shapeProp = type.getProperty("shape");
    if (!shapeProp) return null;
    const shapeType = shapeProp.getTypeAtLocation(decl);
    const props = shapeType.getProperties().map((p) => p.getName());
    if (props.length === 0) return null;
    if (props.some((p) => p.startsWith("__"))) return null;
    return props;
  } catch {
    return null;
  }
}

/**
 * Resolve an expression that references a Zod schema (`InviteMember.input`, `bodySchema`) to its
 * `SymbolRef`, using the index when the declaration was indexed and a structural check otherwise.
 */
export function zodSchemaRefOf(expr: Node, index: ZodIndex, ctx: ProjectContext): SymbolRef | null {
  const e = unwrap(expr);
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    const decl = Node.isPropertyAccessExpression(e) ? resolvePropertyDecl(e) ?? resolveDeclaration(e) : resolveDeclaration(e);
    if (!decl) return null;
    const fact = index.byDeclaration.get(decl);
    if (fact) return fact.ref;
    if (!zodRoot(e)) return null;
    const file = ctx.rel(decl.getSourceFile());
    const symbol = Node.isVariableDeclaration(decl) ? decl.getName() : e.getText();
    return { file, symbol, range: rangeOf(file, decl) };
  }
  if (isZodChain(e)) {
    const file = ctx.rel(e.getSourceFile());
    return { file, symbol: "(inline)", range: rangeOf(file, e) };
  }
  return null;
}

/** For `Obj.member`, the PropertyAssignment inside the object literal declaring `Obj`. */
function resolvePropertyDecl(pa: Node): Node | undefined {
  if (!Node.isPropertyAccessExpression(pa)) return undefined;
  const objDecl = resolveDeclaration(pa.getExpression());
  if (!objDecl || !Node.isVariableDeclaration(objDecl)) return undefined;
  const init = objDecl.getInitializer();
  const obj = init ? unwrap(init) : undefined;
  if (!obj || !Node.isObjectLiteralExpression(obj)) return undefined;
  const prop = obj.getProperty(pa.getName());
  return prop && Node.isPropertyAssignment(prop) ? prop : undefined;
}

