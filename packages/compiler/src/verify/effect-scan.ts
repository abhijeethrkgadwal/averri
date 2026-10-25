/**
 * `effect-scan` (SPEC-IR §3.1): find the Prisma, event and integration effects of a `run`/`handler`/
 * runner body statically. Client recognition, accessor → Entity mapping, write/read operation lists,
 * `$transaction` recursion, interprocedural following to depth 3, and `complete: false` whenever the
 * scan cannot see everything (dynamic access, unknown accessor, external callee receiving a client).
 */

import { Node, type CallExpression } from "ts-morph";
import type { EntityId, EventId, Evidence, IntegrationId } from "@averri/ir";
import { resolveDeclaration } from "@averri/extract";
import { resolveFunction, siteOf } from "../lower/declarations.js";
import { unwrapExpr } from "../lower/literal.js";
import type { BuildState } from "../state.js";
import { rangeOf } from "../util.js";

export const WRITE_OPS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);
export const READ_OPS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
export const RAW_WRITE_OPS = new Set(["$executeRaw", "$executeRawUnsafe"]);
export const RAW_READ_OPS = new Set(["$queryRaw", "$queryRawUnsafe"]);
export const MAX_SCAN_DEPTH = 3;

export interface UnknownEmit {
  call: CallExpression;
  /** Text of the event argument (`MemberInvitd`). */
  name: string;
  /** Payload keys and TS-derived payload types from the emit call's object literal. */
  payload: Array<{ key: string; type: string }>;
}

export interface ScanResult {
  reads: Set<EntityId>;
  writes: Set<EntityId>;
  emits: Set<EventId>;
  calls: Set<IntegrationId>;
  rawReads: boolean;
  rawWrites: boolean;
  complete: boolean;
  evidence: Evidence[];
  unknownEmits: UnknownEmit[];
  /** Integration client calls found (for A4005), with their call nodes. */
  integrationCalls: Array<{ integration: IntegrationId; node: Node }>;
  /** Why the scan is incomplete (first few reasons). */
  incompleteReasons: string[];
}

export interface ScanOptions {
  /** Identifier names that are Prisma clients in the scanned function (`tx`, `db`). */
  clientNames?: Iterable<string>;
  /** Identifier names that are the declared-mode `emit` (destructured or alias). */
  emitNames?: Iterable<string>;
  /** Names of the context parameter (`ctx`) whose `tx`/`db` members are clients and `emit` is the emitter. */
  ctxNames?: Iterable<string>;
  /** Integration client declarations, for `calls` and A4005. */
  integrationClients?: Map<Node, IntegrationId>;
  /**
   * Observe mode: `emitter.eventNamePrefix`. Calls that publish an event by name through the project's
   * own emitter are recognised (D-40): `x.send("<prefix>E", ...)`, `x.send({ name: "<prefix>E" })` and
   * `x.send({ name: helper("E") })` where `E` is a declared Event.
   */
  observeEventPrefix?: string | null;
}

interface Walk {
  observeEventPrefix: string | null;
  state: BuildState;
  result: ScanResult;
  integrationClients: Map<Node, IntegrationId>;
  visited: Set<string>;
}

export function emptyScan(): ScanResult {
  return {
    reads: new Set(),
    writes: new Set(),
    emits: new Set(),
    calls: new Set(),
    rawReads: false,
    rawWrites: false,
    complete: true,
    evidence: [],
    unknownEmits: [],
    integrationCalls: [],
    incompleteReasons: [],
  };
}

/** Parameter names of a declared-mode `run(ctx)`: destructured `tx`/`db`/`emit` or the ctx identifier. */
export function runParamNames(fn: Node): { clientNames: string[]; emitNames: string[]; ctxNames: string[] } {
  const out = { clientNames: [] as string[], emitNames: [] as string[], ctxNames: [] as string[] };
  if (!(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn))) return out;
  const p = fn.getParameters()[0];
  if (!p) return out;
  const nameNode = p.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    out.ctxNames.push(nameNode.getText());
    return out;
  }
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
      const local = el.getName();
      if (prop === "tx" || prop === "db" || prop === "prisma") out.clientNames.push(local);
      if (prop === "emit") out.emitNames.push(local);
    }
  }
  return out;
}

function noteIncomplete(w: Walk, reason: string): void {
  w.result.complete = false;
  if (w.result.incompleteReasons.length < 5 && !w.result.incompleteReasons.includes(reason)) w.result.incompleteReasons.push(reason);
}

const CLIENT_TYPE_RE = /(^|[.<\s(])PrismaClient\b|TransactionClient\b|^Omit<\s*PrismaClient/;

function isClientExpr(w: Walk, expr: Node, scope: Scope): boolean {
  const e = unwrapExpr(expr);
  if (Node.isIdentifier(e) && scope.clients.has(e.getText())) return true;
  if (Node.isPropertyAccessExpression(e)) {
    const obj = unwrapExpr(e.getExpression());
    if (Node.isIdentifier(obj) && scope.ctx.has(obj.getText()) && (e.getName() === "tx" || e.getName() === "db" || e.getName() === "prisma")) return true;
  }
  try {
    const text = e.getType().getText(e);
    if (CLIENT_TYPE_RE.test(text)) return true;
  } catch {
    /* no type information */
  }
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    const decl = resolveDeclaration(e);
    if (decl) {
      const cfg = w.state.config.prismaClient;
      if (cfg && Node.isVariableDeclaration(decl) && decl.getName() === cfg.symbol && w.state.rel(decl.getSourceFile()) === cfg.file) return true;
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        const u = init ? unwrapExpr(init) : undefined;
        if (u && Node.isNewExpression(u) && /PrismaClient\b/.test(u.getExpression().getText())) return true;
      }
    }
  }
  return false;
}

interface Scope {
  clients: Set<string>;
  emit: Set<string>;
  ctx: Set<string>;
  depth: number;
  /** Function node being scanned (to avoid re-scanning). */
  fn: Node;
}

/** Scan a function (or any node: runner initializers) for effects. */
export function scanEffects(state: BuildState, fn: Node, options: ScanOptions = {}): ScanResult {
  const w: Walk = { state, result: emptyScan(), integrationClients: options.integrationClients ?? new Map(), visited: new Set(), observeEventPrefix: options.observeEventPrefix ?? null };
  scanNode(w, fn, {
    clients: new Set(options.clientNames ?? []),
    emit: new Set(options.emitNames ?? []),
    ctx: new Set(options.ctxNames ?? []),
    depth: 0,
    fn,
  });
  return w.result;
}

function scanNode(w: Walk, root: Node, scope: Scope): void {
  const key = `${root.getSourceFile().getFilePath()}:${root.getStart()}:${[...scope.clients].sort().join(",")}:${scope.depth}`;
  if (w.visited.has(key)) return;
  w.visited.add(key);
  root.forEachDescendant((n, traversal) => {
    if (Node.isCallExpression(n)) {
      if (handleCall(w, n, scope)) traversal.skip();
      return;
    }
    if (Node.isTaggedTemplateExpression(n)) {
      const tag = unwrapExpr(n.getTag());
      if (Node.isPropertyAccessExpression(tag) && isClientExpr(w, tag.getExpression(), scope)) recordRaw(w, tag.getName(), n);
      return;
    }
    if (Node.isElementAccessExpression(n)) {
      if (isClientExpr(w, n.getExpression(), scope)) noteIncomplete(w, `dynamic client access ${compactText(n.getText())}`);
    }
  });
}

/** The declared Event a call publishes by name (observe mode), or null. */
function observedEmit(w: Walk, call: CallExpression, prefix: string): EventId | null {
  const known = (name: string): EventId | null => {
    const id = `Event:${name}` as EventId;
    return w.state.nodes.get(id)?.kind === "Event" ? id : null;
  };
  const fromLiteral = (n: Node): EventId | null => {
    const u = unwrapExpr(n);
    if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) {
      const v = u.getLiteralValue();
      return v.startsWith(prefix) ? known(v.slice(prefix.length)) : null;
    }
    // helper("E") that builds the prefixed name
    if (Node.isCallExpression(u)) {
      const args = u.getArguments();
      const a = args[0] ? unwrapExpr(args[0]) : undefined;
      if (args.length === 1 && a && (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a))) return known(a.getLiteralValue());
    }
    return null;
  };
  const first = call.getArguments()[0];
  if (!first) return null;
  const arg = unwrapExpr(first);
  if (Node.isObjectLiteralExpression(arg)) {
    const prop = arg.getProperty("name");
    if (prop && Node.isPropertyAssignment(prop)) {
      const init = prop.getInitializer();
      return init ? fromLiteral(init) : null;
    }
    return null;
  }
  return Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg) ? fromLiteral(arg) : null;
}

function compactText(t: string): string {
  const one = t.replace(/\s+/g, " ");
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

function recordRaw(w: Walk, op: string, at: Node): void {
  const where = `${w.state.rel(at.getSourceFile())}:${at.getStartLineNumber()}`;
  if (RAW_WRITE_OPS.has(op)) {
    w.result.rawWrites = true;
    w.result.evidence.push({ kind: "call", note: `${op} (raw write, no entity) at ${where}` });
  } else if (RAW_READ_OPS.has(op)) {
    w.result.rawReads = true;
    w.result.evidence.push({ kind: "call", note: `${op} (raw read, no entity) at ${where}` });
  }
}

/** Returns true when the call's subtree has been fully handled (skip descendants). */
function handleCall(w: Walk, call: CallExpression, scope: Scope): boolean {
  const callee = unwrapExpr(call.getExpression());
  const file = w.state.rel(call.getSourceFile());
  // client.<accessor>.<op>(...) and client.$op(...)
  if (Node.isPropertyAccessExpression(callee)) {
    const op = callee.getName();
    const recv = unwrapExpr(callee.getExpression());
    if (op.startsWith("$") && isClientExpr(w, recv, scope)) {
      if (op === "$transaction") {
        const arg = call.getArguments()[0];
        const ua = arg ? unwrapExpr(arg) : undefined;
        if (ua && (Node.isArrowFunction(ua) || Node.isFunctionExpression(ua))) {
          const p = ua.getParameters()[0];
          const name = p && Node.isIdentifier(p.getNameNode()) ? p.getName() : null;
          const clients = new Set(scope.clients);
          if (name) clients.add(name);
          scanNode(w, ua, { ...scope, clients, fn: ua });
          return true;
        }
        return false;
      }
      recordRaw(w, op, call);
      return false;
    }
    if (Node.isPropertyAccessExpression(recv) && (WRITE_OPS.has(op) || READ_OPS.has(op))) {
      const accessor = recv.getName();
      const client = unwrapExpr(recv.getExpression());
      if (isClientExpr(w, client, scope)) {
        const ent = w.state.entityByClient.get(accessor);
        const where = `${file}:${call.getStartLineNumber()}:${call.getStart() - call.getStartLinePos()}`;
        if (!ent) {
          noteIncomplete(w, `unknown Prisma accessor ${accessor}`);
          return false;
        }
        const clientText = compactText(client.getText());
        if (WRITE_OPS.has(op)) w.result.writes.add(ent);
        else w.result.reads.add(ent);
        w.result.evidence.push({ kind: "call", note: `${clientText}.${accessor}.${op} at ${where}`, src: rangeOf(file, call) });
        return false;
      }
    }
  }
  // emit(Event, payload) / ctx.emit(Event, payload)
  const isEmit =
    (Node.isIdentifier(callee) && scope.emit.has(callee.getText())) ||
    (Node.isPropertyAccessExpression(callee) &&
      callee.getName() === "emit" &&
      Node.isIdentifier(unwrapExpr(callee.getExpression())) &&
      scope.ctx.has(unwrapExpr(callee.getExpression()).getText()));
  if (isEmit) {
    const evArg = call.getArguments()[0];
    if (evArg) {
      const s = siteOf(w.state, evArg);
      if (s && s.construct === "event" && s.nodeId && w.state.nodes.has(s.nodeId)) {
        w.result.emits.add(s.nodeId as EventId);
        w.result.evidence.push({ kind: "call", note: `emit(${s.id}) at ${file}:${call.getStartLineNumber()}`, src: rangeOf(file, call) });
      } else {
        w.result.unknownEmits.push({ call, name: unwrapExpr(evArg).getText(), payload: payloadOf(call) });
      }
    }
    return false;
  }
  // observe mode: the project's emitter publishing a declared event by name
  if (w.observeEventPrefix !== null && Node.isPropertyAccessExpression(callee)) {
    const ev = observedEmit(w, call, w.observeEventPrefix);
    if (ev !== null) {
      w.result.emits.add(ev);
      w.result.evidence.push({ kind: "call", note: `${compactText(callee.getText())}(${ev}) at ${file}:${call.getStartLineNumber()}`, src: rangeOf(file, call) });
      return false;
    }
  }
  // integration client calls
  const root = rootIdentifier(callee);
  if (root && w.integrationClients.size > 0) {
    const decl = resolveDeclaration(root);
    const integ = decl ? w.integrationClients.get(decl) : undefined;
    if (integ) {
      w.result.calls.add(integ);
      w.result.integrationCalls.push({ integration: integ, node: call });
      w.result.evidence.push({ kind: "call", note: `${compactText(callee.getText())} (${integ.slice("Integration:".length)}) at ${file}:${call.getStartLineNumber()}`, src: rangeOf(file, call) });
    }
  }
  // interprocedural: a callee receiving a client
  const args = call.getArguments();
  const clientArgIdx = args.map((a, i) => (isClientExpr(w, a, scope) ? i : -1)).filter((i) => i >= 0);
  if (clientArgIdx.length > 0) {
    const fn = resolveFunction(callee);
    if (!fn) {
      noteIncomplete(w, `client passed to unresolved callee ${compactText(callee.getText())}`);
      return false;
    }
    const sf = fn.getSourceFile();
    if (sf.isInNodeModules() || sf.isFromExternalLibrary() || sf.isDeclarationFile()) {
      noteIncomplete(w, `client escapes into external ${compactText(callee.getText())}`);
      return false;
    }
    if (scope.depth + 1 > MAX_SCAN_DEPTH) {
      noteIncomplete(w, `call depth > ${MAX_SCAN_DEPTH} at ${compactText(callee.getText())}`);
      return false;
    }
    const params = Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) ? fn.getParameters() : [];
    const clients = new Set<string>();
    for (const i of clientArgIdx) {
      const p = params[i];
      if (!p) continue;
      const nn = p.getNameNode();
      if (Node.isIdentifier(nn)) clients.add(nn.getText());
      else noteIncomplete(w, `client bound to a destructured parameter in ${compactText(callee.getText())}`);
    }
    scanNode(w, fn, { clients, emit: new Set(), ctx: new Set(), depth: scope.depth + 1, fn });
  }
  return false;
}

function rootIdentifier(expr: Node): Node | undefined {
  let cur = unwrapExpr(expr);
  while (Node.isPropertyAccessExpression(cur) || Node.isCallExpression(cur)) cur = unwrapExpr(cur.getExpression());
  return Node.isIdentifier(cur) ? cur : undefined;
}

function payloadOf(call: CallExpression): Array<{ key: string; type: string }> {
  const arg = call.getArguments()[1];
  const u = arg ? unwrapExpr(arg) : undefined;
  if (!u || !Node.isObjectLiteralExpression(u)) return [];
  const out: Array<{ key: string; type: string }> = [];
  for (const p of u.getProperties()) {
    if (!Node.isPropertyAssignment(p) && !Node.isShorthandPropertyAssignment(p)) continue;
    const key = p.getName();
    let type = "json";
    try {
      const t = Node.isPropertyAssignment(p) ? (p.getInitializer() as Node).getType() : p.getNameNode().getType();
      if (t.isString() || t.isStringLiteral()) type = "string";
      else if (t.isNumber() || t.isNumberLiteral()) type = "number";
      else if (t.isBoolean() || t.isBooleanLiteral()) type = "boolean";
      else if (t.getSymbol()?.getName() === "Date") type = "date";
    } catch {
      type = "json";
    }
    out.push({ key, type });
  }
  return out;
}

/** Map integration client declaration nodes to their Integration ids. */
export function integrationClientMap(state: BuildState): Map<Node, IntegrationId> {
  const m = new Map<Node, IntegrationId>();
  for (const f of state.facts) if (f.site.construct === "integration" && f.clientDecl) m.set(f.clientDecl, f.nodeId as IntegrationId);
  return m;
}

