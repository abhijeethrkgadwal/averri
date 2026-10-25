/**
 * Static lowering of `@averri/core` declaration calls to IR nodes and declared edges
 * (SPEC-DECLARATIONS §4.1, D-2). Declarations are found syntactically, identifiers are resolved by
 * symbol to their declaring call, `z.*` chains become `SymbolRef`s with field types from the
 * TypeChecker, `run`/`handler`/`runner`/`client` become `SymbolRef`s whose bodies the verifiers scan.
 * Anything outside the analysable subset is A1004 on the offending property, which is omitted.
 */

import { Node, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import {
  EFFECTS,
  HTTP_METHODS,
  PAYLOAD_TYPES,
  WEBHOOK_SCHEMES,
  collectDbModels,
  contractId,
  entityId,
  isDeclaredId,
  isPascalName,
  moduleId,
  nodeId,
  type ActionNode,
  type BoolExpr,
  type ContractNode,
  type ContractPhase,
  type ContractTier,
  type DbWhere,
  type Diagnostic,
  type DiagnosticCode,
  type Effect,
  type EntityId,
  type EntityNode,
  type EventId,
  type EventNode,
  type HttpMethod,
  type IdempotencySpec,
  type InputSpec,
  type IntegrationNode,
  type NodeId,
  type OutputSpec,
  type PayloadType,
  type PolicyId,
  type PolicyNode,
  type QueryNode,
  type RetrySpec,
  type RouteBinding,
  type SymbolRef,
  type WebhookScheme,
  type WorkflowEngine,
  type WorkflowNode,
} from "@averri/ir";
import { importSourceOf, isZodChain, resolveDeclaration, symbolRefOf } from "@averri/extract";
import { emit } from "../diagnostics.js";
import type { ContractFacts, DeclFacts, DeclSite, InputFacts, OptionProp, ZodFieldType } from "../model.js";
import { addEdge, callKey, declaredProvenance, type BuildState } from "../state.js";
import { closestNames, compareStrings, rangeOf, summaryText } from "../util.js";
import { lowerClause, lowerStandaloneWhere, type Built, type ClauseEnv, type LowerProblem } from "./contracts.js";
import { constructOfCallee, coreBindings, type Construct } from "./core-imports.js";
import { describeExpr, evalLiteral, propertyKey, unwrapExpr, type Literal } from "./literal.js";
import { zodOutputFields } from "./zod-types.js";

const CLAUSE_NAME_RE = /^[a-z][A-Za-z0-9]*$/;

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

/** Every declaration call in the project's source files, in source order. */
export function discoverDeclarations(state: BuildState): DeclSite[] {
  const files = [...state.ctx.sourceFiles].sort(compareStrings);
  const sites: DeclSite[] = [];
  for (const file of files) {
    const sf = state.ctx.sourceFile(file);
    if (!sf) continue;
    const b = coreBindings(sf);
    if (b.constructs.size === 0 && b.namespaces.size === 0) continue;
    const calls: CallExpression[] = [];
    sf.forEachDescendant((n) => {
      if (Node.isCallExpression(n) && constructOfCallee(n.getExpression(), b)) calls.push(n);
    });
    calls.sort((x, y) => x.getStart() - y.getStart());
    for (const call of calls) {
      const construct = constructOfCallee(call.getExpression(), b) as Construct;
      const args = call.getArguments();
      const idArg = args[0];
      const idLit = idArg ? evalLiteral(idArg) : null;
      const id = idLit && idLit.ok && typeof idLit.value === "string" ? idLit.value : null;
      const optArg = args[1] ? unwrapExpr(args[1]) : undefined;
      let parent: Node | undefined = call.getParent();
      while (parent && (Node.isAsExpression(parent) || Node.isSatisfiesExpression(parent) || Node.isParenthesizedExpression(parent))) parent = parent.getParent();
      const constName = parent && Node.isVariableDeclaration(parent) ? parent.getName() : null;
      sites.push({
        construct,
        id,
        nodeId: id === null ? null : nodeIdOf(construct, id),
        file,
        call,
        src: rangeOf(file, call),
        constName,
        options: optArg && Node.isObjectLiteralExpression(optArg) ? optArg : null,
        order: sites.length,
      });
    }
  }
  return sites;
}

export function nodeIdOf(construct: Construct, id: string): NodeId {
  switch (construct) {
    case "entity":
      return nodeId("Entity", id);
    case "policy":
      return nodeId("Policy", id);
    case "action":
      return nodeId("Action", id);
    case "query":
      return nodeId("Query", id);
    case "event":
      return nodeId("Event", id);
    case "workflow":
      return nodeId("Workflow", id);
    case "integration":
      return nodeId("Integration", id);
  }
}

// ---------------------------------------------------------------------------
// resolution helpers
// ---------------------------------------------------------------------------

/** The declaration site an expression denotes: an identifier bound to a declaration const, or an inline declaration call. */
export function siteOf(state: BuildState, expr: Node): DeclSite | null {
  const u = unwrapExpr(expr);
  if (Node.isCallExpression(u)) return state.siteByCall.get(callKey(state.rel(u.getSourceFile()), u)) ?? null;
  if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
    const decl = resolveDeclaration(u);
    if (decl && Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (!init) return null;
      const ui = unwrapExpr(init);
      if (Node.isCallExpression(ui)) return state.siteByCall.get(callKey(state.rel(ui.getSourceFile()), ui)) ?? null;
    }
  }
  return null;
}

function isFunctionLike(n: Node): boolean {
  return Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n);
}

/** Resolve a handler/runner/client expression to the function (or initializer) node it denotes. */
export function resolveFunction(expr: Node): Node | null {
  const u = unwrapExpr(expr);
  if (isFunctionLike(u)) return u;
  if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
    const decl = resolveDeclaration(u);
    if (!decl) return null;
    if (isFunctionLike(decl)) return decl;
    if (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl)) {
      const init = decl.getInitializer();
      if (init && isFunctionLike(unwrapExpr(init))) return unwrapExpr(init);
    }
  }
  return null;
}

/** Lines spanned by a function (inclusive). */
export function functionLines(fn: Node): number {
  return fn.getEndLineNumber() - fn.getStartLineNumber() + 1;
}

// ---------------------------------------------------------------------------
// lowering driver
// ---------------------------------------------------------------------------

interface Sink {
  /** False for duplicates: diagnostics are kept, nodes and edges are discarded. */
  live: boolean;
  diagnostics: Diagnostic[];
}

/** Lower every discovered site. Fills `state.nodes`, `state.edges`, `state.facts`, `state.diagnostics`. */
export function lowerDeclarations(state: BuildState): void {
  state.sites = discoverDeclarations(state);
  for (const s of state.sites) state.siteByCall.set(callKey(s.file, s.call), s);
  const firstById = new Map<NodeId, DeclSite>();
  // Order: entities, events, policies, integrations first so that references resolve; then the rest.
  const rank: Record<Construct, number> = { entity: 0, event: 1, policy: 2, integration: 3, workflow: 4, action: 5, query: 6 };
  const ordered = [...state.sites].sort((a, b) => rank[a.construct] - rank[b.construct] || a.order - b.order);
  // duplicate detection uses source order, independent of the lowering order
  for (const s of state.sites) {
    if (!s.nodeId) continue;
    const first = firstById.get(s.nodeId);
    if (!first) firstById.set(s.nodeId, s);
  }
  for (const s of ordered) {
    if (s.id === null) {
      state.diagnostics.push(
        emit("A1004", {
          node: moduleId(s.file),
          src: s.src,
          message: `${s.construct}() needs a string literal ${s.construct === "action" || s.construct === "query" || s.construct === "policy" ? "id" : "name"} as its first argument; the declaration is skipped`,
        }),
      );
      continue;
    }
    if (!validId(s)) {
      state.diagnostics.push(
        emit("A1004", {
          node: moduleId(s.file),
          src: s.src,
          message: `${JSON.stringify(s.id)} is not a valid ${s.construct} ${s.construct === "action" || s.construct === "query" || s.construct === "policy" ? "id (<Scope>.<name>)" : "name (PascalCase)"}; the declaration is skipped`,
        }),
      );
      continue;
    }
    const first = firstById.get(s.nodeId as NodeId) as DeclSite;
    const live = first === s;
    if (!live) {
      state.diagnostics.push(
        emit("A1001", {
          node: s.nodeId,
          src: s.src,
          message: `${s.nodeId} is declared at ${first.file}:${first.src.range[0][0]} and again at ${s.file}:${s.src.range[0][0]}; the first in source order is kept`,
          cause: [
            { node: s.nodeId as NodeId, why: `declared again at ${s.file}:${s.src.range[0][0]}` },
            { node: s.nodeId as NodeId, why: `first declared at ${first.file}:${first.src.range[0][0]}` },
          ],
        }),
      );
    }
    const sink: Sink = { live, diagnostics: [] };
    const saved = { nodes: new Map(state.nodes), edges: state.edges.length, contracts: new Map(state.contracts) };
    lowerSite(state, s, sink);
    state.diagnostics.push(...sink.diagnostics);
    if (!live) {
      state.nodes = saved.nodes;
      state.edges.length = saved.edges;
      state.contracts = saved.contracts;
    }
  }
  refreshAppliesTo(state);
}

/** Policy.appliesTo mirrors outgoing authorizes edges (re-run after route-match adds Exposure targets). */
export function refreshAppliesTo(state: BuildState): void {
  for (const n of state.nodes.values()) {
    if (n.kind !== "Policy") continue;
    const targets = state.edges.filter((e) => e.kind === "authorizes" && e.from === n.id).map((e) => e.to);
    (n as PolicyNode).appliesTo = Array.from(new Set(targets)).sort(compareStrings) as PolicyNode["appliesTo"];
  }
}

function validId(s: DeclSite): boolean {
  const id = s.id as string;
  if (s.construct === "action" || s.construct === "query" || s.construct === "policy") return isDeclaredId(id);
  return isPascalName(id);
}

// ---------------------------------------------------------------------------
// per-site lowering
// ---------------------------------------------------------------------------

interface SiteCtx {
  state: BuildState;
  site: DeclSite;
  sink: Sink;
  facts: DeclFacts;
  nodeId: NodeId;
}

function a1004(sc: SiteCtx, at: Node, what: string, reason: string): void {
  sc.sink.diagnostics.push(
    emit("A1004", {
      node: sc.nodeId,
      src: rangeOf(sc.site.file, at),
      message: `${sc.site.construct}(${JSON.stringify(sc.site.id)}) option ${what}: ${reason} is not statically analysable; the option is omitted`,
    }),
  );
}

function collectProps(sc: SiteCtx): void {
  const opts = sc.site.options;
  if (!opts) {
    const arg = sc.site.call.getArguments()[1];
    if (arg) a1004(sc, arg, "options", describeExpr(arg));
    return;
  }
  for (const p of opts.getProperties()) {
    if (Node.isPropertyAssignment(p)) {
      const key = propertyKey(p);
      const init = p.getInitializer();
      if (key === null || !init) {
        a1004(sc, p, "<computed key>", "a computed key");
        continue;
      }
      sc.facts.props.set(key, { key, prop: p, value: init });
      sc.facts.keys.push({ key, node: p });
    } else if (Node.isShorthandPropertyAssignment(p)) {
      const key = p.getName();
      sc.facts.props.set(key, { key, prop: p, value: p.getNameNode() });
      sc.facts.keys.push({ key, node: p });
    } else if (Node.isMethodDeclaration(p)) {
      const key = propertyKey(p);
      if (key === null) continue;
      sc.facts.props.set(key, { key, prop: p, value: p });
      sc.facts.keys.push({ key, node: p });
    } else {
      a1004(sc, p, "<spread>", describeExpr(p));
    }
  }
}

function lowerSite(state: BuildState, site: DeclSite, sink: Sink): void {
  const nodeId = site.nodeId as NodeId;
  const facts: DeclFacts = {
    site,
    nodeId,
    props: new Map(),
    keys: [],
    contracts: [],
    input: null,
    outputFields: null,
    outputEntity: null,
    subjectEntity: null,
    body: null,
    bodyResolvable: false,
    clientDecl: null,
    runnerNode: null,
    webhookRoute: null,
    subjectWhereSites: [],
  };
  const sc: SiteCtx = { state, site, sink, facts, nodeId };
  collectProps(sc);
  switch (site.construct) {
    case "entity":
      lowerEntity(sc);
      break;
    case "policy":
      lowerPolicy(sc);
      break;
    case "event":
      lowerEvent(sc);
      break;
    case "action":
    case "query":
      lowerActionOrQuery(sc);
      break;
    case "workflow":
      lowerWorkflow(sc);
      break;
    case "integration":
      lowerIntegration(sc);
      break;
  }
  if (sink.live && state.nodes.has(nodeId)) {
    state.facts.push(facts);
    state.factsById.set(nodeId, facts);
    for (const c of facts.contracts) state.contracts.set(c.id, c);
  }
}

// --- common options ---

function stringOpt(sc: SiteCtx, key: string): string | undefined {
  const p = sc.facts.props.get(key);
  if (!p) return undefined;
  const r = evalLiteral(p.value);
  if (r.ok && typeof r.value === "string") return r.value;
  a1004(sc, p.prop, key, r.ok ? "a non-string value" : r.reason);
  return undefined;
}

function common(sc: SiteCtx): { intent?: string; owner?: string; tags?: string[] } {
  const out: { intent?: string; owner?: string; tags?: string[] } = {};
  const intent = stringOpt(sc, "intent");
  if (intent !== undefined) out.intent = intent;
  const owner = stringOpt(sc, "owner");
  if (owner !== undefined) out.owner = owner;
  const tp = sc.facts.props.get("tags");
  if (tp) {
    const r = evalLiteral(tp.value);
    if (r.ok && Array.isArray(r.value) && r.value.every((x) => typeof x === "string")) out.tags = r.value as string[];
    else a1004(sc, tp.prop, "tags", r.ok ? "a non-string-array value" : r.reason);
  }
  return out;
}

function contains(sc: SiteCtx, to: NodeId): void {
  const mod = moduleId(sc.site.file);
  if (sc.state.nodes.has(mod)) addEdge(sc.state, "contains", mod, to, declaredProvenance(sc.site.src));
}

function entityForModel(sc: SiteCtx, model: string, at: Node | null): EntityId | null {
  const id = sc.state.entityByClient.get(model);
  if (id) return id;
  const candidates = [...sc.state.entityByClient.keys()];
  sc.sink.diagnostics.push(
    emit("A1003", {
      node: sc.nodeId,
      src: at ? rangeOf(sc.site.file, at) : sc.site.src,
      title: `Unknown Prisma model: ${model}`,
      message: `${JSON.stringify(model)} is not a Prisma client accessor in the schema facts${candidates.length ? `; closest: ${closestNames(model, candidates).join(", ")}` : ""}`,
      related: closestNames(model, candidates).map((c) => sc.state.entityByClient.get(c) as EntityId),
    }),
  );
  return null;
}

function entityByName(sc: SiteCtx, name: string, at: Node | null): EntityId | null {
  const id = entityId(name);
  if (sc.state.nodes.get(id)?.kind === "Entity") return id;
  const models = [...sc.state.nodes.values()].filter((n) => n.kind === "Entity").map((n) => (n as EntityNode).model);
  const close = closestNames(name, models);
  sc.sink.diagnostics.push(
    emit("A1003", {
      node: sc.nodeId,
      src: at ? rangeOf(sc.site.file, at) : sc.site.src,
      title: `Unknown Prisma model: ${name}`,
      message: `${JSON.stringify(name)} is not a model in the schema facts${close.length ? `; closest: ${close.join(", ")}` : ""}`,
      related: close.map((m) => entityId(m)),
    }),
  );
  return null;
}

// --- clauses ---

function clauseEnv(sc: SiteCtx): ClauseEnv {
  return {
    rel: (sf: SourceFile) => sc.state.rel(sf),
    resolveEvent: (expr: Node): EventId | null => {
      const s = siteOf(sc.state, expr);
      return s && s.construct === "event" && s.nodeId ? (s.nodeId as EventId) : null;
    },
    sites: [],
    whereSites: [],
    rhsRefLiterals: [],
    problems: [],
  };
}

function problemDiagnostics(sc: SiteCtx, problems: LowerProblem[], node: NodeId): void {
  for (const p of problems) {
    sc.sink.diagnostics.push(
      emit(p.code as DiagnosticCode, {
        node,
        src: rangeOf(sc.state.rel(p.at.getSourceFile()), p.at),
        message: p.message,
        ...(p.fixes ? { fixes: p.fixes } : {}),
      }),
    );
  }
}

/**
 * Lower one clause into a Contract node (+ constrains/contains/reads edges) and its facts.
 * Returns null when the clause could not be represented.
 */
function lowerContract(sc: SiteCtx, phase: ContractPhase, clause: string, valueNode: Node, propNode: Node, allowedTiers: ContractTier[]): ContractFacts | null {
  const owner = sc.nodeId;
  const id = contractId(owner, phase, phase === "allow" ? null : clause);
  const env = clauseEnv(sc);
  const built: Built = lowerClause(valueNode, env);
  const dropped = env.problems.some((p) => p.drop) || built.t === "fail" || built.t === "value" || built.t === "dbvalue";
  if (built.t === "value" || built.t === "dbvalue") {
    env.problems.push({ code: "A1004", message: `${phase}.${clause} is a value, not a boolean clause`, at: valueNode, drop: true });
  }
  const tier: ContractTier = built.t === "guard" ? "guard" : built.t === "clause" ? (containsDbOp(built.ast) ? "predicate" : "expr") : "expr";
  if (!dropped && !allowedTiers.includes(tier)) {
    env.problems.push({
      code: "A3003",
      message: `${phase} clauses must be ${allowedTiers.join(" or ")} tier; ${clause} is ${tier === "guard" ? "an opaque guard" : `a ${tier}`}`,
      at: valueNode,
      drop: true,
    });
  }
  const finalDropped = env.problems.some((p) => p.drop);
  problemDiagnostics(sc, env.problems, finalDropped ? owner : id);
  if (finalDropped) return null;
  const src = rangeOf(sc.site.file, propNode);
  const ast = built.t === "clause" ? built.ast : null;
  const node: ContractNode = {
    id,
    kind: "Contract",
    name: id.slice("Contract:".length),
    summary: "",
    provenance: declaredProvenance(src),
    src,
    of: owner as ContractNode["of"],
    phase,
    clause: phase === "allow" ? "allow" : clause,
    tier,
    expr: ast,
    opaque: tier === "guard",
  };
  sc.state.nodes.set(id, node);
  addEdge(sc.state, "constrains", id, owner, declaredProvenance(src));
  contains(sc, id);
  if (ast) {
    for (const model of collectDbModels(ast)) {
      const ent = entityForModel(sc, model, valueNode);
      if (ent) addEdge(sc.state, "reads", id, ent, declaredProvenance(src));
    }
  }
  const facts: ContractFacts = {
    id,
    owner,
    phase,
    clause: node.clause,
    tier,
    ast,
    guard: built.t === "guard" ? built.fn : null,
    src,
    file: sc.site.file,
    prop: propNode,
    sites: env.sites,
    whereSites: env.whereSites,
    rhsRefLiterals: env.rhsRefLiterals,
  };
  sc.facts.contracts.push(facts);
  return facts;
}

function containsDbOp(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsDbOp);
  if (typeof node !== "object" || node === null) return false;
  const r = node as Record<string, unknown>;
  if (typeof r.op === "string" && r.op.startsWith("db.")) return true;
  return Object.keys(r).some((k) => containsDbOp(r[k]));
}

/** `requires`/`ensures`/`invariant` objects: clause name → clause. */
function lowerClauseObject(sc: SiteCtx, key: string, phase: ContractPhase, allowed: ContractTier[]): ContractFacts[] {
  const p = sc.facts.props.get(key);
  if (!p) return [];
  const obj = unwrapExpr(p.value);
  if (!Node.isObjectLiteralExpression(obj)) {
    a1004(sc, p.prop, key, describeExpr(p.value));
    return [];
  }
  const out: ContractFacts[] = [];
  const seen = new Set<string>();
  for (const cp of obj.getProperties()) {
    let name: string | null = null;
    let value: Node | null = null;
    if (Node.isPropertyAssignment(cp)) {
      name = propertyKey(cp);
      value = cp.getInitializer() ?? null;
    } else if (Node.isMethodDeclaration(cp)) {
      name = propertyKey(cp);
      value = cp;
    } else if (Node.isShorthandPropertyAssignment(cp)) {
      name = cp.getName();
      value = cp.getNameNode();
    }
    if (name === null || value === null) {
      a1004(sc, cp, key, describeExpr(cp));
      continue;
    }
    if (name.startsWith("$") || !CLAUSE_NAME_RE.test(name)) {
      sc.sink.diagnostics.push(
        emit("A1004", {
          node: sc.nodeId,
          src: rangeOf(sc.site.file, cp),
          message: name.startsWith("$")
            ? `clause name ${JSON.stringify(name)} starts with "$", which is reserved for synthetic contracts; the clause is omitted`
            : `clause name ${JSON.stringify(name)} is not a camelCase identifier; the clause is omitted`,
        }),
      );
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const f = lowerContract(sc, phase, name, value, cp, allowed);
    if (f) out.push(f);
  }
  return out;
}

// --- entity ---

function lowerEntity(sc: SiteCtx): void {
  const name = sc.site.id as string;
  const nodeId = sc.nodeId;
  const existing = sc.state.nodes.get(nodeId);
  if (!existing || existing.kind !== "Entity") {
    entityByName(sc, name, sc.site.call.getArguments()[0] ?? null);
    return;
  }
  const c = common(sc);
  const ent: EntityNode = { ...(existing as EntityNode), provenance: declaredProvenance(sc.site.src), ...c };
  sc.state.nodes.set(nodeId, ent);
  contains(sc, nodeId);
  sc.facts.subjectEntity = nodeId as EntityId;
  const inv = lowerClauseObject(sc, "invariant", "invariant", ["expr"]);
  ent.invariants = inv.map((f) => f.id);
}

// --- policy ---

function lowerPolicy(sc: SiteCtx): void {
  const id = sc.nodeId as PolicyId;
  const allowId = contractId(id, "allow", null);
  const c = common(sc);
  const node: PolicyNode = {
    id,
    kind: "Policy",
    name: sc.site.id as string,
    summary: "",
    provenance: declaredProvenance(sc.site.src),
    src: sc.site.src,
    ...c,
    allow: allowId,
    tier: "expr",
    appliesTo: [],
  };
  sc.state.nodes.set(id, node);
  contains(sc, id);
  const p = sc.facts.props.get("allow");
  if (!p) {
    sc.sink.diagnostics.push(emit("A1004", { node: id, src: sc.site.src, message: `policy(${JSON.stringify(sc.site.id)}) has no statically analysable allow clause` }));
    sc.state.nodes.delete(id);
    return;
  }
  const f = lowerContract(sc, "allow", "allow", p.value, p.prop, ["expr", "predicate", "guard"]);
  if (!f) {
    sc.state.nodes.delete(id);
    sc.state.edges = sc.state.edges.filter((e) => e.to !== id && e.from !== id);
    return;
  }
  node.tier = f.tier;
  if (f.ast) {
    for (const model of collectDbModels(f.ast)) {
      const ent = sc.state.entityByClient.get(model);
      if (ent) addEdge(sc.state, "reads", id, ent, declaredProvenance(sc.site.src));
    }
  }
}

// --- event ---

function lowerEvent(sc: SiteCtx): void {
  const c = common(sc);
  const payload: Record<string, PayloadType> = {};
  const p = sc.facts.props.get("payload");
  if (p) {
    const r = evalLiteral(p.value);
    if (r.ok && isObj(r.value) && Object.values(r.value).every((v) => typeof v === "string" && (PAYLOAD_TYPES as readonly string[]).includes(v))) {
      for (const [k, v] of Object.entries(r.value)) payload[k] = v as PayloadType;
    } else a1004(sc, p.prop, "payload", r.ok ? "a payload whose values are not PayloadType literals" : r.reason);
  }
  let external = false;
  const ep = sc.facts.props.get("external");
  if (ep) {
    const r = evalLiteral(ep.value);
    if (r.ok && typeof r.value === "boolean") external = r.value;
    else a1004(sc, ep.prop, "external", r.ok ? "a non-boolean value" : r.reason);
  }
  const node: EventNode = {
    id: sc.nodeId,
    kind: "Event",
    name: sc.site.id as string,
    summary: "",
    provenance: declaredProvenance(sc.site.src),
    src: sc.site.src,
    ...c,
    payload,
    external,
  };
  sc.state.nodes.set(sc.nodeId, node);
  contains(sc, sc.nodeId);
}

function isObj(v: Literal): v is { [k: string]: Literal } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- action / query ---

function lowerRoute(sc: SiteCtx): RouteBinding | null {
  const p = sc.facts.props.get("route");
  if (!p) return null;
  const r = evalLiteral(p.value);
  if (r.ok && isObj(r.value) && typeof r.value.method === "string" && typeof r.value.path === "string") {
    if (!(HTTP_METHODS as readonly string[]).includes(r.value.method)) {
      a1004(sc, p.prop, "route.method", `${JSON.stringify(r.value.method)} (not one of ${HTTP_METHODS.join(", ")})`);
      return null;
    }
    return { method: r.value.method as HttpMethod, path: r.value.path, exposure: null, verified: false };
  }
  a1004(sc, p.prop, "route", r.ok ? "a value that is not { method, path }" : r.reason);
  return null;
}

function zodRefFor(sc: SiteCtx, expr: Node, member: string): SymbolRef | null {
  const u = unwrapExpr(expr);
  if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
    const decl = resolveDeclaration(u);
    if (!decl) return null;
    const ref = symbolRefOf(u, sc.state.root, sc.site.file);
    return ref;
  }
  return { file: sc.site.file, symbol: `${sc.site.constName ?? sc.site.id}.${member}`, range: rangeOf(sc.site.file, u) };
}

function isZodExpr(expr: Node): boolean {
  const u = unwrapExpr(expr);
  if (isZodChain(u)) return true;
  if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
    const decl = resolveDeclaration(u);
    if (decl && (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl))) {
      const init = decl.getInitializer();
      return init ? isZodChain(unwrapExpr(init)) : false;
    }
  }
  return false;
}

function lowerInput(sc: SiteCtx): InputSpec {
  const p = sc.facts.props.get("input");
  if (!p) return { zod: null, fields: [] };
  if (!isZodExpr(p.value)) {
    a1004(sc, p.prop, "input", `${describeExpr(p.value)} (expected a z.* schema or a reference to one)`);
    sc.facts.input = { fields: null, complete: false, isZod: false };
    return { zod: null, fields: [] };
  }
  const ref = zodRefFor(sc, p.value, "input");
  const shape = zodOutputFields(unwrapExpr(p.value));
  let fields: Map<string, ZodFieldType> | null = shape?.fields ?? null;
  let complete = shape?.method === "checker";
  if (!fields && ref) {
    const fact = sc.state.extract.zodSchemas.find((z) => z.ref.file === ref.file && z.ref.symbol === ref.symbol);
    if (fact) {
      fields = new Map(fact.fields.map((f) => [f, { kind: "unknown", nullable: false, optional: false } as ZodFieldType]));
      complete = fact.complete;
    }
  }
  if (fields) for (const ft of fields.values()) if (ft.site && ft.site.file === "") ft.site.file = sc.state.rel(p.value.getSourceFile());
  sc.facts.input = { fields, complete: complete || (shape?.method === "ast" && !!fields), isZod: true };
  return { zod: ref, fields: fields ? [...fields.keys()] : [] };
}

function lowerOutput(sc: SiteCtx): OutputSpec {
  const p = sc.facts.props.get("output");
  if (!p) return { kind: "unknown" };
  const u = unwrapExpr(p.value);
  const lit = evalLiteral(u);
  if (lit.ok && typeof lit.value === "string") {
    if (lit.value === "void") return { kind: "void" };
    const ent = entityByName(sc, lit.value, p.prop);
    if (ent) {
      sc.facts.outputEntity = ent;
      return { entity: ent };
    }
    return { kind: "unknown" };
  }
  const site = siteOf(sc.state, u);
  if (site) {
    if (site.construct === "entity" && site.id) {
      const ent = entityByName(sc, site.id, p.prop);
      if (ent) {
        sc.facts.outputEntity = ent;
        return { entity: ent };
      }
      return { kind: "unknown" };
    }
    a1004(sc, p.prop, "output", `a ${site.construct}() declaration`);
    return { kind: "unknown" };
  }
  if (isZodExpr(u)) {
    const ref = zodRefFor(sc, u, "output");
    const shape = zodOutputFields(u);
    if (shape) sc.facts.outputFields = shape.fields;
    return ref ? { zod: ref } : { kind: "unknown" };
  }
  a1004(sc, p.prop, "output", describeExpr(u));
  return { kind: "unknown" };
}

function lowerPolicyRef(sc: SiteCtx): PolicyId | null {
  const p = sc.facts.props.get("policy");
  if (!p) return null;
  const site = siteOf(sc.state, p.value);
  if (site && site.construct === "policy" && site.nodeId) {
    if (!sc.state.nodes.has(site.nodeId)) return null;
    return site.nodeId as PolicyId;
  }
  a1004(sc, p.prop, "policy", `${describeExpr(p.value)} (expected a policy() declaration)`);
  return null;
}

function lowerSubject(sc: SiteCtx): { entity: EntityId; where: DbWhere } | null {
  const p = sc.facts.props.get("subject");
  if (!p) return null;
  const obj = unwrapExpr(p.value);
  if (!Node.isObjectLiteralExpression(obj)) {
    a1004(sc, p.prop, "subject", describeExpr(p.value));
    return null;
  }
  const ep = obj.getProperty("entity");
  const wp = obj.getProperty("where");
  if (!ep || !Node.isPropertyAssignment(ep) || !wp || !Node.isPropertyAssignment(wp)) {
    a1004(sc, p.prop, "subject", "an object without entity and where");
    return null;
  }
  const ev = ep.getInitializer() as Node;
  let entity: EntityId | null = null;
  const lit = evalLiteral(ev);
  if (lit.ok && typeof lit.value === "string") entity = entityByName(sc, lit.value, ep);
  else {
    const s = siteOf(sc.state, ev);
    if (s && s.construct === "entity" && s.id) entity = entityByName(sc, s.id, ep);
    else a1004(sc, ep, "subject.entity", describeExpr(ev));
  }
  const env = clauseEnv(sc);
  const whereInit = wp.getInitializer() as Node;
  const model = entity ? (sc.state.nodes.get(entity) as EntityNode).clientName : "";
  const where = lowerStandaloneWhere(whereInit, model, env);
  for (const site of env.sites) {
    const root = site.ref.split(".")[0];
    if (root !== "input" && root !== "actor") {
      env.problems.push({ code: "A3003", message: `subject.where may reference input and actor only, got ${site.ref}`, at: whereInit, drop: true });
    }
  }
  problemDiagnostics(sc, env.problems, sc.nodeId);
  sc.facts.subjectWhereSites = env.whereSites;
  if (!entity || !where || env.problems.some((x) => x.drop)) return null;
  sc.facts.subjectEntity = entity;
  return { entity, where };
}


function lowerEffects(sc: SiteCtx): Effect[] {
  const p = sc.facts.props.get("effects");
  if (!p) return [];
  const r = evalLiteral(p.value);
  if (r.ok && Array.isArray(r.value) && r.value.every((v) => typeof v === "string" && (EFFECTS as readonly string[]).includes(v))) {
    return Array.from(new Set(r.value as Effect[]));
  }
  a1004(sc, p.prop, "effects", r.ok ? "a list that is not made of Effect literals" : r.reason);
  return [];
}

function lowerIdempotency(sc: SiteCtx, key = "idempotency"): IdempotencySpec | null {
  const p = sc.facts.props.get(key);
  if (!p) return null;
  const r = evalLiteral(p.value);
  if (r.ok && isObj(r.value) && isObj(r.value.key ?? null) && typeof r.value.ttlSeconds === "number" && r.value.ttlSeconds > 0) {
    const k = r.value.key as { [k: string]: Literal };
    const ttl = Math.round(r.value.ttlSeconds);
    if (typeof k.header === "string") return { key: { header: k.header }, ttlSeconds: ttl };
    if (typeof k.input === "string") return { key: { input: k.input }, ttlSeconds: ttl };
  }
  a1004(sc, p.prop, key, r.ok ? "a value that is not { key: { header } | { input }, ttlSeconds }" : r.reason);
  return null;
}

function lowerActionOrQuery(sc: SiteCtx): void {
  const isAction = sc.site.construct === "action";
  const c = common(sc);
  const route = lowerRoute(sc);
  const input = lowerInput(sc);
  const output = lowerOutput(sc);
  const policy = lowerPolicyRef(sc);
  let isPublic = false;
  const pubProp = sc.facts.props.get("public");
  if (pubProp) {
    const r = evalLiteral(pubProp.value);
    if (r.ok && r.value === true) isPublic = true;
    else a1004(sc, pubProp.prop, "public", r.ok ? "a value other than true" : r.reason);
  }
  const runProp = sc.facts.props.get("run");
  const handlerProp = sc.facts.props.get("handler");
  const mode = runProp ? "declared" : "observe";
  let handler: SymbolRef | null = null;
  if (runProp) {
    const fn = unwrapExpr(runProp.value);
    if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn)) {
      sc.facts.body = fn;
      sc.facts.bodyResolvable = true;
      handler = { file: sc.site.file, symbol: `${sc.site.constName ?? sc.site.id}.run`, range: rangeOf(sc.site.file, fn) };
    } else {
      const resolved = resolveFunction(fn);
      handler = symbolRefOf(fn, sc.state.root, sc.site.file);
      if (resolved) {
        sc.facts.body = resolved;
        sc.facts.bodyResolvable = true;
      }
    }
  } else if (handlerProp) {
    const resolved = resolveFunction(handlerProp.value);
    handler = symbolRefOf(unwrapExpr(handlerProp.value), sc.state.root, sc.site.file);
    if (resolved) {
      sc.facts.body = resolved;
      sc.facts.bodyResolvable = true;
    }
  }
  const handlerLines = sc.facts.body ? functionLines(sc.facts.body) : 0;
  const nodeBase = {
    id: sc.nodeId,
    name: sc.site.id as string,
    summary: "",
    provenance: declaredProvenance(sc.site.src),
    src: sc.site.src,
    ...c,
  };
  if (isAction) {
    const subject = lowerSubject(sc);
    let transaction = mode === "declared";
    const tp = sc.facts.props.get("transaction");
    if (tp && mode === "declared") {
      const r = evalLiteral(tp.value);
      if (r.ok && r.value === false) transaction = false;
      else if (r.ok && (r.value === true || isObj(r.value))) transaction = true;
      else a1004(sc, tp.prop, "transaction", r.ok ? "a value other than a boolean or { timeout, maxWait }" : r.reason);
    }
    const node: ActionNode = {
      ...nodeBase,
      kind: "Action",
      mode,
      route,
      input,
      output,
      policy,
      public: isPublic,
      subject,
      contracts: [],
      effects: { declared: lowerEffects(sc), verified: { reads: [], writes: [], emits: [], calls: [], complete: false } },
      transaction,
      idempotency: lowerIdempotency(sc),
      handler,
      ratios: { opaqueGuards: 0, totalContracts: 0, handlerLines },
    } as ActionNode;
    sc.state.nodes.set(sc.nodeId, node);
    contains(sc, sc.nodeId);
    const req = lowerClauseObject(sc, "requires", "requires", ["expr", "predicate", "guard"]);
    const ens = lowerClauseObject(sc, "ensures", "ensures", ["expr", "predicate", "guard"]);
    node.contracts = [...req, ...ens].map((f) => f.id);
    node.ratios.totalContracts = node.contracts.length;
    node.ratios.opaqueGuards = [...req, ...ens].filter((f) => f.tier === "guard").length;
  } else {
    const node: QueryNode = {
      ...nodeBase,
      kind: "Query",
      mode,
      route,
      input,
      output,
      policy,
      public: isPublic,
      reads: [],
      handler,
      ratios: { handlerLines },
    } as QueryNode;
    sc.state.nodes.set(sc.nodeId, node);
    contains(sc, sc.nodeId);
  }
  const prov = declaredProvenance(sc.site.src);
  if (policy) addEdge(sc.state, "authorizes", policy, sc.nodeId, prov);
  if (sc.facts.outputEntity) addEdge(sc.state, "returns", sc.nodeId, sc.facts.outputEntity, prov);
  if (input.zod) {
    const mod = moduleId(input.zod.file);
    if (sc.state.nodes.has(mod)) addEdge(sc.state, "validatesWith", sc.nodeId, mod, prov, { symbol: input.zod.symbol });
  }
  if (handler) {
    const mod = moduleId(handler.file);
    if (sc.state.nodes.has(mod)) addEdge(sc.state, "implementedBy", sc.nodeId, mod, prov, { symbol: handler.symbol });
  }
}

// --- workflow ---

function lowerWorkflow(sc: SiteCtx): void {
  const c = common(sc);
  let on: EventId | null = null;
  const op = sc.facts.props.get("on");
  if (op) {
    const s = siteOf(sc.state, op.value);
    if (s && s.construct === "event" && s.nodeId && sc.state.nodes.has(s.nodeId)) on = s.nodeId as EventId;
    else a1004(sc, op.prop, "on", `${describeExpr(op.value)} (expected an event() declaration)`);
  }
  if (!on) {
    if (!op) sc.sink.diagnostics.push(emit("A1004", { node: sc.nodeId, src: sc.site.src, message: `workflow(${JSON.stringify(sc.site.id)}) has no statically analysable on: Event` }));
    return;
  }
  let runner: SymbolRef | null = null;
  const rp = sc.facts.props.get("runner");
  let runnerNode: Node | null = null;
  if (rp) {
    const u = unwrapExpr(rp.value);
    runner = symbolRefOf(u, sc.state.root, sc.site.file);
    if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
      const decl = resolveDeclaration(u);
      if (decl && (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl))) runnerNode = decl.getInitializer() ?? decl;
      else runnerNode = decl ?? null;
    } else runnerNode = u;
  }
  sc.facts.runnerNode = runnerNode;
  let engine: WorkflowEngine | null = null;
  const enp = sc.facts.props.get("engine");
  if (enp) {
    const r = evalLiteral(enp.value);
    if (r.ok && (r.value === "inngest" || r.value === "pg-boss" || r.value === "custom")) engine = r.value;
    else a1004(sc, enp.prop, "engine", r.ok ? "a value other than inngest | pg-boss | custom" : r.reason);
  }
  if (!engine) engine = inferEngine(rp?.value ?? null, runnerNode);
  let retry: RetrySpec | null = null;
  const retp = sc.facts.props.get("retry");
  if (retp) {
    const r = evalLiteral(retp.value);
    if (r.ok && isObj(r.value) && typeof r.value.attempts === "number") {
      retry = { attempts: r.value.attempts };
      if (r.value.backoff === "fixed" || r.value.backoff === "exponential") retry.backoff = r.value.backoff;
    } else a1004(sc, retp.prop, "retry", r.ok ? "a value that is not { attempts, backoff? }" : r.reason);
  }
  const steps: string[] = [];
  if (runnerNode) {
    runnerNode.forEachDescendant((n) => {
      if (!Node.isCallExpression(n)) return;
      const callee = n.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "run") return;
      const recv = callee.getExpression();
      if (!Node.isIdentifier(recv) || recv.getText() !== "step") return;
      const a = n.getArguments()[0];
      const r = a ? evalLiteral(a) : null;
      if (r && r.ok && typeof r.value === "string" && !steps.includes(r.value)) steps.push(r.value);
    });
  }
  const node: WorkflowNode = {
    id: sc.nodeId,
    kind: "Workflow",
    name: sc.site.id as string,
    summary: "",
    provenance: declaredProvenance(sc.site.src),
    src: sc.site.src,
    ...c,
    on,
    engine,
    runner,
    retry,
    steps,
  };
  sc.state.nodes.set(sc.nodeId, node);
  contains(sc, sc.nodeId);
  addEdge(sc.state, "consumedBy", on, sc.nodeId, declaredProvenance(sc.site.src));
}

function inferEngine(expr: Node | null, runnerNode: Node | null): WorkflowEngine {
  const texts: string[] = [];
  if (expr) {
    const u = unwrapExpr(expr);
    let root: Node = u;
    while (Node.isPropertyAccessExpression(root) || Node.isCallExpression(root)) root = Node.isCallExpression(root) ? root.getExpression() : root.getExpression();
    const src = Node.isIdentifier(root) ? importSourceOf(root) : null;
    if (src) texts.push(src);
  }
  if (runnerNode) {
    texts.push(runnerNode.getText().slice(0, 400));
    if (Node.isCallExpression(runnerNode)) {
      let root: Node = runnerNode.getExpression();
      while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
      const src = Node.isIdentifier(root) ? importSourceOf(root) : null;
      if (src) texts.push(src);
    }
  }
  const all = texts.join("\n");
  if (/inngest/i.test(all) || /\.createFunction\s*\(/.test(all)) return "inngest";
  if (/pg-boss/i.test(all) || /\bboss\.work\s*\(/.test(all)) return "pg-boss";
  return "custom";
}

// --- integration ---

function lowerIntegration(sc: SiteCtx): void {
  const c = common(sc);
  let client: SymbolRef | null = null;
  const cp = sc.facts.props.get("client");
  if (cp) {
    const u = unwrapExpr(cp.value);
    if (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) {
      client = symbolRefOf(u, sc.state.root, sc.site.file);
      sc.facts.clientDecl = resolveDeclaration(u) ?? null;
    } else a1004(sc, cp.prop, "client", `${describeExpr(u)} (expected a reference to the client object)`);
  }
  let webhook: IntegrationNode["webhook"] = null;
  const wp = sc.facts.props.get("webhook");
  if (wp) {
    const r = evalLiteral(wp.value);
    if (
      r.ok &&
      isObj(r.value) &&
      typeof r.value.verify === "string" &&
      typeof r.value.scheme === "string" &&
      (WEBHOOK_SCHEMES as readonly string[]).includes(r.value.scheme) &&
      typeof r.value.rawBody === "boolean"
    ) {
      webhook = {
        verify: r.value.verify,
        scheme: r.value.scheme as WebhookScheme,
        secretEnv: typeof r.value.secretEnv === "string" ? r.value.secretEnv : null,
        rawBody: r.value.rawBody,
        exposure: null,
      };
      const route = r.value.route;
      if (isObj(route ?? null)) {
        const rr = route as { [k: string]: Literal };
        if (typeof rr.method === "string" && typeof rr.path === "string") sc.facts.webhookRoute = { method: rr.method as HttpMethod, path: rr.path };
      }
    } else a1004(sc, wp.prop, "webhook", r.ok ? "a value that is not { verify, scheme, secretEnv?, rawBody, route? }" : r.reason);
  }
  let nonTransactional = true;
  const np = sc.facts.props.get("nonTransactional");
  if (np) {
    const r = evalLiteral(np.value);
    if (r.ok && typeof r.value === "boolean") nonTransactional = r.value;
    else a1004(sc, np.prop, "nonTransactional", r.ok ? "a non-boolean value" : r.reason);
  }
  lowerEffectsOptional(sc);
  const node: IntegrationNode = {
    id: sc.nodeId,
    kind: "Integration",
    name: sc.site.id as string,
    summary: "",
    provenance: declaredProvenance(sc.site.src),
    src: sc.site.src,
    ...c,
    client,
    webhook,
    idempotency: lowerIdempotency(sc),
    nonTransactional,
  };
  sc.state.nodes.set(sc.nodeId, node);
  contains(sc, sc.nodeId);
}

function lowerEffectsOptional(sc: SiteCtx): void {
  if (sc.facts.props.has("effects")) lowerEffects(sc);
}

