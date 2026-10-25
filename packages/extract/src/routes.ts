/**
 * Hono and Express route extraction -> Exposure nodes (SPEC-IR §4.1, D-8).
 *
 * 1. Every `new Hono()` / `new OpenAPIHono()` / `express()` / `express.Router()` / `Router()` is a
 *    router instance. Call chains rooted at an instance (directly, through a variable, an import or
 *    `export default`) contribute ops in source order: `basePath`, `use`, `route`/`use` mounts and
 *    `get|post|put|patch|delete|all|on` registrations. Express `app.route(path).get(h)` builders are
 *    supported. Receivers that cannot be traced to a creation (a parameter typed `Hono`, a factory
 *    result) become unresolved instances.
 * 2. Roots are instances nobody mounts, restricted to `entryPoints` when configured. Walking the
 *    mount tree composes static prefixes and carries `use()` middleware forward; an instance reached
 *    twice keeps its first path (`router-mounted-twice`); instances never reached are walked alone
 *    with the unprefixed path (`router-unreached`).
 * 3. Exposure id = `<router>:<file>:<line>:<col>` of the method identifier. `all` expands to five
 *    Exposures whose ids use the identifier column + 0..4 (D-36); `on([...])` uses each method
 *    literal's own position.
 *
 * Confidence (SPEC-IR §4.1 table): 0.98 static path on a root; 0.95 composed through a static mount
 * prefix/basePath; 0.6 dynamic path or dynamic mount (`dynamic: true`); 0.5 never reached from an
 * entry point (`dynamic: true`).
 */

import { Node, SyntaxKind, type CallExpression, type Expression } from "ts-morph";
import { exposureId, moduleId, type Edge, type Evidence, type ExposureNode, type HttpMethod, type Router, type SymbolRef } from "@averri/ir";
import { composePath, middlewareMatches, normalizeRoutePath, toHttpMethod, usePatternMatches } from "./paths.js";
import type { ProjectContext } from "./project.js";
import { argsOf, importSourceOf, resolveDeclaration, rootIdentifier, staticString, staticStringArray, symbolRefOf, unwrap } from "./resolve.js";
import type { ExtractWarning } from "./types.js";
import { compactText, compareStrings, extracted, positionOf, rangeOf, summary } from "./util.js";
import { zodSchemaRefOf, type ZodIndex } from "./zod.js";

export const ROUTE_CONFIDENCE = { root: 0.98, mounted: 0.95, dynamic: 0.6, unreached: 0.5 } as const;

const VERBS: Record<string, HttpMethod[]> = {
  get: ["GET"],
  post: ["POST"],
  put: ["PUT"],
  patch: ["PATCH"],
  delete: ["DELETE"],
  all: ["GET", "POST", "PUT", "PATCH", "DELETE"],
};
const HONO_CLASSES = new Set(["Hono", "OpenAPIHono"]);
const PARSE_FNS = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync"]);

interface Instance {
  key: string;
  router: Router;
  name: string;
  file: string;
  node: Node;
  /** Receiver could not be traced to a creation expression (parameter, factory call). */
  unresolved: boolean;
  basePath: string | null;
  basePathDynamic: boolean;
  ops: Op[];
  mountedBy: MountOp[];
}

interface MethodSlot {
  method: HttpMethod;
  posNode: Node;
  colOffset: number;
}

interface RouteOp {
  type: "route";
  order: number;
  file: string;
  call: CallExpression;
  methodName: string;
  methods: MethodSlot[];
  path: string | null;
  pathText: string;
  handlerArgs: Expression[];
}
interface UseOp {
  type: "use";
  order: number;
  file: string;
  call: CallExpression;
  pattern: string | null;
  patternDynamic: boolean;
  middlewares: Expression[];
}
interface MountOp {
  type: "mount";
  order: number;
  file: string;
  call: CallExpression;
  methodName: string;
  parent: Instance;
  prefix: string | null;
  prefixText: string;
  dynamicContext: boolean;
  child: Instance | null;
  childText: string;
}
type Op = RouteOp | UseOp | MountOp;

interface ActiveUse {
  router: Router;
  pattern: string | null;
  middlewares: string[];
  evidence: Evidence;
}

interface WalkFlags {
  viaMount: boolean;
  dynamic: boolean;
  unreached: boolean;
  mountEvidence: Evidence[];
}

export interface RouteExtraction {
  nodes: ExposureNode[];
  edges: Edge[];
  warnings: ExtractWarning[];
  routers: Router[];
  /** Files with a router instance or a registration. */
  routeFiles: string[];
  /** Files declaring a handler referenced by a registration (by symbol, not inline). */
  handlerFiles: string[];
  /** Entry points actually used as mount-tree roots. */
  entryPoints: string[];
}

export function extractRoutes(ctx: ProjectContext, zod: ZodIndex, files: readonly string[] = ctx.sourceFiles): RouteExtraction {
  const warnings: ExtractWarning[] = [];
  const instances = new Map<Node, Instance>();
  const routeFiles = new Set<string>();
  const handlerFiles = new Set<string>();
  const fileIndex = new Map<string, number>();
  const sortedFiles = [...files].sort(compareStrings);
  sortedFiles.forEach((f, i) => fileIndex.set(f, i));

  const orderOf = (n: Node): number => (fileIndex.get(ctx.rel(n.getSourceFile())) ?? sortedFiles.length) * 2 ** 32 + n.getStart();

  // --- 1. collect instances and ops ---------------------------------------------
  for (const rel of sortedFiles) {
    const sf = ctx.sourceFile(rel);
    if (!sf) continue;
    sf.forEachDescendant((node) => {
      if (Node.isNewExpression(node) || Node.isCallExpression(node)) {
        if (creationOf(node)) {
          getOrCreate(node);
          routeFiles.add(rel);
          return;
        }
      }
      if (!Node.isCallExpression(node)) return;
      if (!isOutermostChainCall(node)) return;
      const { root, calls } = unwindChain(node);
      if (calls.length === 0) return;
      const inst = instanceForRoot(root);
      if (!inst) return;
      routeFiles.add(rel);
      processChain(inst, calls, rel);
    });
  }

  // --- 2. mount tree ---------------------------------------------------------------
  const all = [...instances.values()].sort((a, b) => orderOf(a.node) - orderOf(b.node));
  for (const inst of all) inst.ops.sort((a, b) => a.order - b.order);
  const configured = ctx.options.entryPoints;
  let roots = all.filter((i) => i.mountedBy.length === 0 && !i.unresolved);
  if (configured) {
    roots = roots.filter((i) => configured.includes(i.file));
  }
  const entryPoints = [...new Set(roots.map((r) => r.file))].sort(compareStrings);
  if (!configured && roots.length > 0) {
    warnings.push({
      code: "entry-points-detected",
      message: `entryPoints not configured; using unmounted router instances in ${entryPoints.join(", ")} as roots`,
    });
  }

  const visited = new Set<Instance>();
  const exposures = new Map<string, ExposureNode>();
  const edges: Edge[] = [];

  for (const root of roots) walk(root, "/", [], { viaMount: false, dynamic: false, unreached: false, mountEvidence: [] });
  for (const inst of all) {
    if (visited.has(inst)) continue;
    const hasRoutes = inst.ops.some((o) => o.type === "route" || o.type === "mount");
    if (hasRoutes) {
      const src = rangeOf(inst.file, inst.node);
      warnings.push(
        inst.unresolved
          ? {
              code: "route-receiver-unresolved",
              message: `${inst.name} in ${inst.file} registers routes but is not traceable to a router creation; its exposures are dynamic (0.5)`,
              file: inst.file,
              src,
            }
          : {
              code: "router-unreached",
              message: `${inst.name} in ${inst.file} is never mounted from an entry point; its exposures are dynamic (0.5)`,
              file: inst.file,
              src,
            },
      );
    }
    walk(inst, "/", [], { viaMount: false, dynamic: true, unreached: true, mountEvidence: [] });
  }

  const nodes = [...exposures.values()].sort((a, b) => compareStrings(a.id, b.id));
  const routers = [...new Set(all.map((i) => i.router))].sort(compareStrings);
  return {
    nodes,
    edges,
    warnings,
    routers,
    routeFiles: [...routeFiles].sort(compareStrings),
    handlerFiles: [...handlerFiles].sort(compareStrings),
    entryPoints,
  };

  // --- helpers --------------------------------------------------------------------

  function getOrCreate(creation: Node): Instance {
    const existing = instances.get(creation);
    if (existing) return existing;
    const c = creationOf(creation)!;
    const file = ctx.rel(creation.getSourceFile());
    const inst: Instance = {
      key: `${file}#${creation.getStart()}`,
      router: c.router,
      name: instanceName(creation, c.isRouter ? "router" : "app"),
      file,
      node: creation,
      unresolved: false,
      basePath: null,
      basePathDynamic: false,
      ops: [],
      mountedBy: [],
    };
    instances.set(creation, inst);
    return inst;
  }

  function getOrCreateUnresolved(decl: Node, router: Router, name: string): Instance {
    const existing = instances.get(decl);
    if (existing) return existing;
    const file = ctx.rel(decl.getSourceFile());
    const inst: Instance = {
      key: `${file}#${decl.getStart()}`,
      router,
      name,
      file,
      node: decl,
      unresolved: true,
      basePath: null,
      basePathDynamic: false,
      ops: [],
      mountedBy: [],
    };
    instances.set(decl, inst);
    return inst;
  }

  /** Instance for the root of a chain: a creation, or an identifier resolving (through imports) to one. */
  function instanceForRoot(rootNode: Node, depth = 0): Instance | null {
    const root = unwrap(rootNode);
    if (creationOf(root)) return getOrCreate(root);
    if (Node.isCallExpression(root) || Node.isNewExpression(root)) {
      // a chain whose innermost element is a creation, e.g. `new Hono().basePath("/api")` as a mount argument
      const inner = unwindChain(root);
      if (inner.calls.length > 0 && creationOf(inner.root)) return getOrCreate(inner.root);
    }
    if (!Node.isIdentifier(root) && !Node.isPropertyAccessExpression(root)) return null;
    if (depth > 5) return null;
    const decl = resolveDeclaration(root);
    if (decl) {
      const init = Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl) ? decl.getInitializer() : Node.isExportAssignment(decl) ? decl.getExpression() : undefined;
      if (init) {
        const u = unwrap(init);
        if (creationOf(u)) return getOrCreate(u);
        const inner = unwindChain(u);
        if (inner.calls.length > 0 && creationOf(inner.root)) return getOrCreate(inner.root);
        if (Node.isVariableDeclaration(decl) && (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u))) {
          const viaAlias = instanceForRoot(u, depth + 1);
          if (viaAlias) return viaAlias;
        }
      }
    }
    const router = routerFromType(root);
    if (!router) return null;
    const anchor = decl ?? root;
    const name = Node.isIdentifier(root) ? root.getText() : compactText(root.getText());
    return getOrCreateUnresolved(anchor, router, name);
  }

  function processChain(inst: Instance, calls: CallExpression[], file: string): void {
    let builderPath: { path: string | null; text: string } | null = null;
    for (const call of calls) {
      const callee = unwrap(call.getExpression());
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const name = callee.getName();
      const ident = callee.getNameNode();
      const order = orderOf(ident);
      const args = argsOf(call);

      if (name === "basePath" && inst.router === "hono") {
        const a0 = args[0];
        if (!a0) continue;
        const s = staticString(a0);
        inst.basePath = s ?? compactText(a0.getText());
        inst.basePathDynamic = s === null;
        continue;
      }
      if (name === "route") {
        if (inst.router === "express" && args.length === 1 && args[0]) {
          const s = staticString(args[0]);
          builderPath = { path: s, text: compactText(args[0].getText()) };
          continue;
        }
        if (inst.router === "hono" && args.length >= 2 && args[0] && args[1]) {
          addMount(inst, call, name, args[0], args[1], order, file);
        }
        continue;
      }
      if (name === "use") {
        const first = args[0];
        if (!first) continue;
        const patterns = patternsOf(first);
        const rest = patterns.given ? args.slice(1) : args;
        const middlewares: Expression[] = [];
        for (const arg of rest) {
          const child = inst.router === "express" ? instanceForRoot(arg) : null;
          if (child) {
            for (const pat of patterns.list) {
              const mount: MountOp = {
                type: "mount",
                order: order + 0.5,
                file,
                call,
                methodName: name,
                parent: inst,
                prefix: pat.value,
                prefixText: pat.text,
                dynamicContext: inDynamicContext(call),
                child,
                childText: compactText(arg.getText()),
              };
              inst.ops.push(mount);
              child.mountedBy.push(mount);
            }
          } else {
            middlewares.push(arg);
          }
        }
        if (middlewares.length > 0) {
          for (const pat of patterns.list) {
            inst.ops.push({ type: "use", order, file, call, pattern: pat.value, patternDynamic: pat.dynamic, middlewares });
          }
        }
        continue;
      }
      if (name === "on" || name in VERBS) {
        let methods: MethodSlot[] = [];
        let pathArg: Expression | undefined;
        let handlerArgs: Expression[];
        if (name === "on") {
          const m0 = args[0];
          if (!m0) continue;
          const one = staticString(m0);
          const many = one === null ? staticStringArray(m0) : null;
          const arr = unwrap(m0);
          if (one !== null) {
            const hm = toHttpMethod(one);
            if (hm) methods.push({ method: hm, posNode: ident, colOffset: 0 });
          } else if (many) {
            many.forEach((m, i) => {
              const hm = toHttpMethod(m);
              if (!hm) return;
              const posNode = Node.isArrayLiteralExpression(arr) ? (arr.getElements()[i] ?? ident) : ident;
              methods.push({ method: hm, posNode, colOffset: Node.isArrayLiteralExpression(arr) ? 0 : i });
            });
          } else {
            warnings.push({
              code: "route-dynamic-path",
              message: `${inst.name}.on(...) at ${file}:${ident.getStartLineNumber()} has a non-literal method list; skipped`,
              file,
              src: rangeOf(file, call),
            });
            continue;
          }
          pathArg = args[1];
          handlerArgs = args.slice(2);
        } else {
          methods = VERBS[name]!.map((m, i) => ({ method: m, posNode: ident, colOffset: i }));
          if (builderPath) {
            handlerArgs = args;
          } else {
            pathArg = args[0];
            handlerArgs = args.slice(1);
          }
        }
        if (methods.length === 0 || handlerArgs.length === 0) continue;
        let path: string | null;
        let pathText: string;
        if (builderPath && !pathArg) {
          path = builderPath.path;
          pathText = builderPath.text;
        } else if (pathArg) {
          path = staticString(pathArg);
          pathText = compactText(pathArg.getText());
        } else {
          continue;
        }
        // Express accepts path arrays; one Exposure id per registration, so keep the first path.
        if (path === null && pathArg) {
          const arr = staticStringArray(pathArg);
          if (arr && arr.length > 0) {
            path = arr[0]!;
            if (arr.length > 1) {
              warnings.push({
                code: "exposure-duplicate-id",
                message: `${inst.name}.${name}([...]) at ${file}:${ident.getStartLineNumber()} registers ${arr.length} paths; only the first (${arr[0]}) gets an Exposure`,
                file,
                src: rangeOf(file, call),
              });
            }
          }
        }
        if (path === null) {
          warnings.push({
            code: "route-dynamic-path",
            message: `${inst.name}.${name}(${pathText}) at ${file}:${ident.getStartLineNumber()} has a non-literal path`,
            file,
            src: rangeOf(file, call),
          });
        }
        inst.ops.push({ type: "route", order, file, call, methodName: name, methods, path, pathText, handlerArgs });
        continue;
      }
      // anything else (`notFound`, `onError`, `listen`, `param`, `set`, ...) passes through
    }
  }

  function addMount(parent: Instance, call: CallExpression, methodName: string, prefixArg: Expression, childArg: Expression, order: number, file: string): void {
    const s = staticString(prefixArg);
    const child = instanceForRoot(childArg);
    const mount: MountOp = {
      type: "mount",
      order,
      file,
      call,
      methodName,
      parent,
      prefix: s,
      prefixText: compactText(prefixArg.getText()),
      dynamicContext: inDynamicContext(call),
      child,
      childText: compactText(childArg.getText()),
    };
    parent.ops.push(mount);
    if (child) child.mountedBy.push(mount);
  }

  function walk(inst: Instance, prefix: string, inherited: ActiveUse[], flags: WalkFlags): void {
    if (visited.has(inst)) {
      if (flags.viaMount) {
        warnings.push({
          code: "router-mounted-twice",
          message: `${inst.name} in ${inst.file} is mounted more than once; the first mount path is used`,
          file: inst.file,
          src: rangeOf(inst.file, inst.node),
        });
      }
      return;
    }
    visited.add(inst);
    let localPrefix = prefix;
    let viaMount = flags.viaMount;
    let dynamic = flags.dynamic;
    if (inst.basePath !== null) {
      localPrefix = inst.basePathDynamic ? rawJoin(prefix, inst.basePath) : composePath(prefix, inst.basePath);
      viaMount = viaMount || normalizeRoutePath(inst.basePath) !== "/";
      dynamic = dynamic || inst.basePathDynamic;
    }
    const active: ActiveUse[] = [...inherited];
    for (const op of inst.ops) {
      if (op.type === "use") {
        if (op.patternDynamic) continue;
        const pattern = op.pattern === null ? (inst.router === "hono" ? composePath(localPrefix, "*") : localPrefix) : composePath(localPrefix, op.pattern);
        const middlewares = op.middlewares.map((m) => compactText(m.getText()));
        const line = op.call.getStartLineNumber();
        active.push({
          router: inst.router,
          pattern,
          middlewares,
          evidence: {
            kind: "source",
            note: `${middlewares.join(", ")} from ${inst.name}.use(${op.pattern === null ? "" : JSON.stringify(op.pattern)}) at ${op.file}:${line}`,
            src: rangeOf(op.file, op.call),
          },
        });
        continue;
      }
      if (op.type === "mount") {
        if (!op.child) {
          warnings.push({
            code: "router-dynamic-mount",
            message: `${inst.name}.${op.methodName}(${op.prefixText}, ${op.childText}) at ${op.file}:${op.call.getStartLineNumber()}: the mounted router is not statically resolvable`,
            file: op.file,
            src: rangeOf(op.file, op.call),
          });
          continue;
        }
        const childPrefix = op.prefix === null ? rawJoin(localPrefix, op.prefixText) : composePath(localPrefix, op.prefix);
        const dyn = op.prefix === null || op.dynamicContext;
        if (dyn) {
          warnings.push({
            code: "router-dynamic-mount",
            message: `${inst.name}.${op.methodName}(${op.prefixText}, ${op.childText}) at ${op.file}:${op.call.getStartLineNumber()} is a dynamic mount`,
            file: op.file,
            src: rangeOf(op.file, op.call),
          });
        }
        const ev: Evidence = {
          kind: "route",
          note: `mounted at ${op.prefix ?? op.prefixText} by ${inst.name}.${op.methodName} in ${op.file}:${op.call.getStartLineNumber()}`,
          src: rangeOf(op.file, op.call),
        };
        walk(op.child, childPrefix, [...active], {
          viaMount: true,
          dynamic: dynamic || dyn,
          unreached: flags.unreached,
          mountEvidence: [...flags.mountEvidence, ev],
        });
        continue;
      }
      emitRoute(inst, op, localPrefix, active, { viaMount, dynamic, unreached: flags.unreached, mountEvidence: flags.mountEvidence });
    }
  }

  function emitRoute(inst: Instance, op: RouteOp, localPrefix: string, active: ActiveUse[], flags: WalkFlags): void {
    const sf = op.call.getSourceFile();
    const fullPath = op.path === null ? rawJoin(localPrefix, op.pathText) : composePath(localPrefix, op.path);
    const pathDynamic = op.path === null;
    const matchedUses = active.filter((u) => usePatternMatches(u.router, u.pattern, fullPath));
    const inlineMw = op.handlerArgs.slice(0, -1).map((m) => compactText(m.getText()));
    const middleware = [...matchedUses.flatMap((u) => u.middlewares), ...inlineMw];
    const handlerExpr = op.handlerArgs[op.handlerArgs.length - 1]!;
    const handler = symbolRefOf(handlerExpr, ctx.rootDir, op.file);
    if (handler.symbol !== "(anonymous)" && handler.range) handlerFiles.add(handler.file);
    const bodySchema = findBodySchema(op.handlerArgs, handlerExpr);

    const dynamic = flags.unreached || flags.dynamic || pathDynamic;
    const confidence = flags.unreached
      ? ROUTE_CONFIDENCE.unreached
      : flags.dynamic || pathDynamic
        ? ROUTE_CONFIDENCE.dynamic
        : flags.viaMount
          ? ROUTE_CONFIDENCE.mounted
          : ROUTE_CONFIDENCE.root;
    const isPublic = ctx.options.publicMarker !== null && middleware.some((m) => middlewareMatches(m, [ctx.options.publicMarker!]));
    const src = rangeOf(op.file, op.call);

    for (const slot of op.methods) {
      const pos = positionOf(sf, slot.posNode.getStart());
      const line = pos[0];
      const col = pos[1] + slot.colOffset;
      const id = exposureId(inst.router, op.file, line, col);
      if (exposures.has(id)) {
        warnings.push({ code: "exposure-duplicate-id", message: `two registrations resolve to ${id}; the first is kept`, file: op.file, src });
        continue;
      }
      const evidence: Evidence[] = [
        {
          kind: "route",
          note: `${slot.method} ${fullPath} registered via ${inst.name}.${op.methodName}(${JSON.stringify(op.path ?? op.pathText)}) at ${op.file}:${line}:${col}`,
          src,
        },
        ...flags.mountEvidence,
        ...matchedUses.map((u) => u.evidence),
      ];
      if (bodySchema) evidence.push({ kind: "schema", note: `body validated by ${bodySchema.symbol} (${bodySchema.file})` });
      if (flags.unreached) evidence.push({ kind: "source", note: `${inst.name} is not reached from an entry point; path is unprefixed` });
      const node: ExposureNode = {
        id,
        kind: "Exposure",
        name: `${slot.method} ${fullPath}`,
        summary: summary(
          `${slot.method} ${fullPath} · ${inst.router} · ${middleware.length ? `middleware ${middleware.join(", ")}` : "no middleware"} · handler ${handler.symbol}${dynamic ? " · dynamic" : ""}`,
        ),
        provenance: extracted(inst.router, confidence, evidence),
        src,
        router: inst.router,
        method: slot.method,
        path: fullPath,
        handler,
        middleware,
        boundTo: null,
        bodySchema,
        dynamic,
        public: isPublic,
      };
      exposures.set(id, node);
      edges.push({
        kind: "contains",
        from: moduleId(op.file),
        to: id,
        provenance: extracted(inst.router, 1, [{ kind: "route", note: `${op.file} registers ${slot.method} ${fullPath}`, src }]),
      });
      if (bodySchema) {
        edges.push({
          kind: "validatesWith",
          from: id,
          to: moduleId(bodySchema.file),
          provenance: extracted(inst.router, confidence, [{ kind: "schema", note: `${slot.method} ${fullPath} validates its body with ${bodySchema.symbol}`, src }]),
          attrs: { symbol: bodySchema.symbol },
        });
      }
    }
  }

  /** Zod schema used by a validator middleware argument or by `schema.parse(...)` inside the handler body. */
  function findBodySchema(handlerArgs: Expression[], handlerExpr: Expression): SymbolRef | null {
    for (const mw of handlerArgs.slice(0, -1)) {
      const m = unwrap(mw);
      if (!Node.isCallExpression(m)) continue;
      for (const arg of m.getArguments()) {
        const ref = zodSchemaRefOf(arg, zod, ctx);
        if (ref) return ref;
      }
    }
    const body = functionBodyOf(handlerExpr);
    if (!body) return null;
    let found: SymbolRef | null = null;
    body.forEachDescendant((n, traversal) => {
      if (found) return traversal.stop();
      if (!Node.isCallExpression(n)) return undefined;
      const callee = unwrap(n.getExpression());
      if (!Node.isPropertyAccessExpression(callee) || !PARSE_FNS.has(callee.getName())) return undefined;
      const ref = zodSchemaRefOf(callee.getExpression(), zod, ctx);
      if (ref) {
        found = ref;
        traversal.stop();
      }
      return undefined;
    });
    return found;
  }
}

// --- pure helpers ---------------------------------------------------------------------

interface Creation {
  router: Router;
  isRouter: boolean;
}

/** Recognise `new Hono()`, `new OpenAPIHono()`, `express()`, `express.Router()`, `Router()`. */
export function creationOf(node: Node): Creation | null {
  if (Node.isNewExpression(node)) {
    const expr = unwrap(node.getExpression());
    if (!Node.isIdentifier(expr) || !HONO_CLASSES.has(expr.getText())) return null;
    const spec = importSourceOf(expr);
    if (spec !== null && !(spec === "hono" || spec.startsWith("hono/") || spec.startsWith("@hono/"))) return null;
    return { router: "hono", isRouter: false };
  }
  if (Node.isCallExpression(node)) {
    const callee = unwrap(node.getExpression());
    if (Node.isIdentifier(callee)) {
      const name = callee.getText();
      const spec = importSourceOf(callee);
      if (name === "express" && (spec === null || spec === "express")) return { router: "express", isRouter: false };
      if (name === "Router" && (spec === null || spec === "express")) return { router: "express", isRouter: true };
      return null;
    }
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "Router") {
      const root = rootIdentifier(callee.getExpression());
      if (!root) return null;
      const spec = importSourceOf(root);
      if (spec === null ? root.getText() === "express" : spec === "express") return { router: "express", isRouter: true };
    }
  }
  return null;
}

/** True when the call is not itself the receiver of an outer `.x(...)` call. */
function isOutermostChainCall(call: CallExpression): boolean {
  const callee = unwrap(call.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return false;
  let p: Node | undefined = call.getParent();
  while (p && (Node.isParenthesizedExpression(p) || Node.isAsExpression(p) || Node.isNonNullExpression(p) || Node.isSatisfiesExpression(p))) p = p.getParent();
  if (p && Node.isPropertyAccessExpression(p) && unwrap(p.getExpression()) === unwrap(call)) {
    const gp = p.getParent();
    if (gp && Node.isCallExpression(gp) && unwrap(gp.getExpression()) === p) return false;
  }
  return true;
}

/** Walk a call chain inward; `calls` are innermost-first and stop at a creation expression. */
function unwindChain(node: Node): { root: Node; calls: CallExpression[] } {
  const calls: CallExpression[] = [];
  let cur: Node = unwrap(node);
  while (Node.isCallExpression(cur) && !creationOf(cur)) {
    const callee = unwrap(cur.getExpression());
    if (!Node.isPropertyAccessExpression(callee)) break;
    calls.unshift(cur);
    cur = unwrap(callee.getExpression());
  }
  return { root: cur, calls };
}

/** Variable / export name a creation is bound to: `const app = new Hono()` -> `app`; `export default` -> `default`. */
function instanceName(creation: Node, fallback: string): string {
  let cur: Node | undefined = creation;
  while (cur) {
    const parent: Node | undefined = cur.getParent();
    if (!parent) break;
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isPropertyAssignment(parent)) return parent.getName();
    if (Node.isExportAssignment(parent)) return "default";
    if (
      Node.isCallExpression(parent) ||
      Node.isPropertyAccessExpression(parent) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent) ||
      Node.isNonNullExpression(parent)
    ) {
      if (Node.isCallExpression(parent) && parent.getArguments().some((a) => a === cur)) return `(${fallback})`;
      cur = parent;
      continue;
    }
    break;
  }
  return `(${fallback})`;
}

function routerFromType(node: Node): Router | null {
  try {
    const text = node.getType().getText();
    if (/\bHono\b|\bOpenAPIHono\b/.test(text)) return "hono";
    if (/\bExpress\b|\bRouter\b|\bApplication\b|\bIRouter\b/.test(text)) return "express";
  } catch {
    /* no checker info */
  }
  return null;
}

interface PatternList {
  given: boolean;
  list: Array<{ value: string | null; text: string; dynamic: boolean }>;
}

/** First `use()` argument: a path, an array of paths, or (when it is a function) nothing. */
function patternsOf(first: Expression): PatternList {
  const e = unwrap(first);
  if (Node.isArrowFunction(e) || Node.isFunctionExpression(e)) return { given: false, list: [{ value: null, text: "", dynamic: false }] };
  const s = staticString(e);
  if (s !== null) return { given: true, list: [{ value: s, text: s, dynamic: false }] };
  const arr = staticStringArray(e);
  if (arr) return { given: true, list: arr.map((v) => ({ value: v, text: v, dynamic: false })) };
  if (Node.isStringLiteral(e) || Node.isTemplateExpression(e) || Node.isArrayLiteralExpression(e)) {
    return { given: true, list: [{ value: null, text: compactText(e.getText()), dynamic: true }] };
  }
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    // a middleware reference (`app.use(auth)`) or a router variable; treat as "no pattern"
    try {
      const t = e.getType().getText();
      if (t === "string" || t.startsWith('"') || t.startsWith("`") || /^string\[\]/.test(t)) {
        return { given: true, list: [{ value: null, text: compactText(e.getText()), dynamic: true }] };
      }
    } catch {
      /* ignore */
    }
  }
  return { given: false, list: [{ value: null, text: "", dynamic: false }] };
}

function inDynamicContext(node: Node): boolean {
  let p: Node | undefined = node.getParent();
  while (p) {
    const k = p.getKind();
    if (
      k === SyntaxKind.ForStatement ||
      k === SyntaxKind.ForOfStatement ||
      k === SyntaxKind.ForInStatement ||
      k === SyntaxKind.WhileStatement ||
      k === SyntaxKind.DoStatement ||
      k === SyntaxKind.IfStatement ||
      k === SyntaxKind.ConditionalExpression ||
      k === SyntaxKind.SwitchStatement
    ) {
      return true;
    }
    p = p.getParent();
  }
  return false;
}

/**
 * Join a static prefix with a non-static path text. Template literals keep their `${expr}` holes; any
 * other expression is rendered as one `${expr}` placeholder, so a dynamic path is recognisable as such.
 */
function rawJoin(prefix: string, text: string): string {
  const p = prefix === "/" ? "" : prefix.replace(/\/+$/, "");
  const t = text.startsWith("`") ? text.slice(1, -1) : `\${${text}}`;
  return `${p}${t.startsWith("/") ? "" : "/"}${t}`;
}

/** Body of an inline function or of the function a handler identifier resolves to. */
function functionBodyOf(expr: Expression): Node | null {
  const e = unwrap(expr);
  if (Node.isArrowFunction(e) || Node.isFunctionExpression(e)) return e.getBody();
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    const decl = resolveDeclaration(e);
    if (!decl) return null;
    if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) return decl.getBody() ?? null;
    if (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl)) {
      const init = decl.getInitializer();
      const u = init ? unwrap(init) : undefined;
      if (u && (Node.isArrowFunction(u) || Node.isFunctionExpression(u))) return u.getBody();
    }
  }
  return null;
}

