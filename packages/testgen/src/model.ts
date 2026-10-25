/**
 * Owner models: everything a suite needs to know about an Action/Query, derived once from the graph.
 * Includes static input-type inference (the IR only records input FIELD NAMES; types come from the
 * contracts' literals, `where` keys, the subject/output entity and, last, the field name).
 */

import {
  isLit,
  isRef,
  parseNodeId,
  refRoot,
  refSegments,
  walkExpr,
  whereLeaves,
  type ActionNode,
  type BoolExpr,
  type ContractExpr,
  type ContractId,
  type ContractNode,
  type DbWhere,
  type EntityNode,
  type EventId,
  type Graph,
  type LitScalar,
  type Node,
  type NodeId,
  type PolicyNode,
  type QueryNode,
} from "@averri/ir";
import { arbitrarySource, isIsoDate, valueTypeOfField, valueTypeOfLiteral, valueTypeOfName, type ValueType } from "./arbitraries.js";
import { analyseClause, mergeConjunction, type ClauseAnalysis, type Conjunction, type FieldConstraint } from "./constraints.js";
import { ident, keySource, litSource, str } from "./emit.js";
import { SchemaFacts } from "./schema.js";
import type { ResolvedOptions } from "./types.js";

export interface Ctx {
  graph: Graph;
  facts: SchemaFacts;
  options: ResolvedOptions;
}

export function node<K extends Node["kind"]>(ctx: Ctx, id: NodeId | string | null | undefined, kind: K): Extract<Node, { kind: K }> | null {
  if (!id) return null;
  const n = ctx.graph.nodes[id as NodeId];
  return n && n.kind === kind ? (n as Extract<Node, { kind: K }>) : null;
}

export interface InputField {
  name: string;
  type: ValueType;
}

export interface EmittedClause {
  contract: ContractNode;
  event: EventId;
  count: number | { min?: number; max?: number } | undefined;
}

export interface ActionModel {
  node: ActionNode | QueryNode;
  owner: NodeId;
  qualifier: string;
  /** Identifier-safe prefix for emitted helpers (`Team_inviteMember`). */
  prefix: string;
  policy: PolicyNode | null;
  policyContract: ContractNode | null;
  contracts: ContractNode[];
  requires: ContractNode[];
  /** Tier-1 ensures clauses that are not `emitted` assertions. */
  ensures: ContractNode[];
  emitted: EmittedClause[];
  guards: ContractNode[];
  inputFields: InputField[];
  subjectEntity: EntityNode | null;
  subjectWhere: DbWhere | null;
  /** Tier-1 requires analyses keyed by contract id. */
  analyses: Map<ContractId, ClauseAnalysis>;
  /** Client accessor names of `effects.verified.writes` entities (empty for queries). */
  writes: string[];
}

export function buildActionModel(ctx: Ctx, n: ActionNode | QueryNode): ActionModel {
  const qualifier = parseNodeId(n.id)?.qualifier ?? n.id;
  const policy = node(ctx, n.policy, "Policy");
  const policyContract = policy ? node(ctx, policy.allow, "Contract") : null;
  const contracts = n.kind === "Action" ? n.contracts.map((id) => node(ctx, id, "Contract")).filter((c): c is ContractNode => c !== null) : [];
  const requires = contracts.filter((c) => c.phase === "requires" && c.tier !== "guard");
  const guards = contracts.filter((c) => c.tier === "guard");
  const emitted: EmittedClause[] = [];
  const ensures: ContractNode[] = [];
  for (const c of contracts) {
    if (c.phase !== "ensures" || c.tier === "guard" || !c.expr) continue;
    if (c.expr.op === "emitted") emitted.push({ contract: c, event: c.expr.event, count: c.expr.count });
    else if (c.tier === "expr") ensures.push(c);
  }
  const subjectEntity = n.kind === "Action" && n.subject ? ctx.facts.entity(n.subject.entity) : null;
  const subjectWhere = n.kind === "Action" && n.subject ? n.subject.where : null;
  const analyses = new Map<ContractId, ClauseAnalysis>();
  for (const c of requires) if (c.tier === "expr" && c.expr) analyses.set(c.id as ContractId, analyseClause(c.expr));
  const writes =
    n.kind === "Action"
      ? n.effects.verified.writes.map((id) => ctx.facts.entity(id)?.clientName ?? null).filter((c): c is string => c !== null)
      : [];
  const model: ActionModel = {
    node: n,
    owner: n.id,
    qualifier,
    prefix: ident(qualifier),
    policy,
    policyContract,
    contracts,
    requires,
    ensures,
    emitted,
    guards,
    inputFields: [],
    subjectEntity,
    subjectWhere,
    analyses,
    writes,
  };
  model.inputFields = inferInputTypes(ctx, model);
  return model;
}

// ---------------------------------------------------------------------------
// Input type inference
// ---------------------------------------------------------------------------

function inputFieldOf(operand: ContractExpr): string | null {
  if (!isRef(operand)) return null;
  if (refRoot(operand.ref) !== "input") return null;
  const segs = refSegments(operand.ref);
  return segs.length === 1 ? (segs[0] as string) : null;
}

function inferInputTypes(ctx: Ctx, m: ActionModel): InputField[] {
  const n = m.node;
  const names = [...n.input.fields];
  const hints = new Map<string, ValueType[]>();
  const add = (name: string, t: ValueType | null) => {
    if (!t) return;
    const list = hints.get(name) ?? [];
    list.push(t);
    hints.set(name, list);
  };
  const exprs: BoolExpr[] = [];
  for (const c of m.contracts) if (c.expr) exprs.push(c.expr);
  if (m.policyContract?.expr) exprs.push(m.policyContract.expr);

  // 1. literals the input is compared with
  for (const e of exprs) {
    walkExpr(e, (x) => {
      if (typeof x !== "object" || x === null || !("op" in x)) return;
      if (x.op === "eq" || x.op === "ne" || x.op === "lt" || x.op === "lte" || x.op === "gt" || x.op === "gte") {
        const f = inputFieldOf(x.lhs) ?? inputFieldOf(x.rhs);
        const lit = isLit(x.lhs) ? x.lhs : isLit(x.rhs) ? x.rhs : null;
        if (f && lit && !Array.isArray(lit.lit) && lit.lit !== null) add(f, valueTypeOfLiteral(lit.lit, f));
      } else if (x.op === "in") {
        const f = inputFieldOf(x.lhs);
        if (f && isLit(x.rhs) && Array.isArray(x.rhs.lit)) {
          const first = x.rhs.lit.find((v) => v !== null);
          if (first !== undefined) add(f, valueTypeOfLiteral(first, f));
        }
      }
    });
  }
  // 2. where keys the input is bound to (predicates and policy)
  for (const e of exprs) {
    walkExpr(e, (x) => {
      if (typeof x !== "object" || x === null || !("op" in x)) return;
      if (x.op !== "db.exists" && x.op !== "db.none" && x.op !== "db.unique" && x.op !== "db.countWhere") return;
      const entity = ctx.facts.entityByClient(x.model);
      if (!entity) return;
      for (const leaf of whereLeaves(x.where)) {
        const f = inputFieldOf(leaf.value);
        if (!f) continue;
        const resolved = ctx.facts.resolveWhereKey(entity, leaf.key);
        if (resolved.field) add(f, valueTypeOfField(resolved.field.type, f, resolved.field.unique || resolved.field.isId));
      }
    });
  }
  // 3. subject.where
  if (m.subjectEntity && m.subjectWhere) {
    for (const leaf of whereLeaves(m.subjectWhere)) {
      const f = inputFieldOf(leaf.value);
      if (!f) continue;
      const resolved = ctx.facts.resolveWhereKey(m.subjectEntity, leaf.key);
      if (resolved.field) add(f, valueTypeOfField(resolved.field.type, f, resolved.field.unique || resolved.field.isId));
    }
  }
  // 4. same-named field on the output / subject entity, then on any entity (when unambiguous)
  const outputEntity = "entity" in n.output ? ctx.facts.entity(n.output.entity) : null;
  for (const name of names) {
    for (const entity of [outputEntity, m.subjectEntity]) {
      const f = entity ? ctx.facts.field(entity, name) : null;
      if (f && f.type.kind !== "relation") add(name, valueTypeOfField(f.type, name, f.unique));
    }
    const candidates = ctx.facts
      .entities()
      .map((e) => ctx.facts.field(e, name))
      .filter((f): f is NonNullable<typeof f> => f !== null && f.type.kind !== "relation");
    if (candidates.length > 0) {
      const kinds = new Set(candidates.map((f) => valueTypeOfField(f.type, name).kind));
      if (kinds.size === 1) add(name, valueTypeOfField((candidates[0] as NonNullable<(typeof candidates)[0]>).type, name, candidates.some((f) => f.unique)));
    }
  }
  // 5. name heuristics
  for (const name of names) add(name, valueTypeOfName(name));

  return names.map((name) => {
    const list = hints.get(name) ?? [];
    const first = list.find((t) => t.kind !== "unsupported") ?? { kind: "string", hint: name };
    // a later hint may know the column is unique even when the first one came from a literal
    const unique = list.some((t) => t.unique === true);
    return { name, type: { ...first, hint: name, unique } };
  });
}

// ---------------------------------------------------------------------------
// Constraint -> arbitrary source
// ---------------------------------------------------------------------------

export type SourceResult = { ok: true; src: string } | { ok: false; reason: string };

function boundNumber(value: number | string, exclusive: boolean, direction: 1 | -1, kind: ValueType["kind"]): number {
  const v = typeof value === "number" ? value : Date.parse(value);
  if (!exclusive) return v;
  if (kind === "float") return v + direction * 1e-6;
  return v + direction;
}

function literalFor(value: LitScalar, type: ValueType, flavour: "wire" | "row"): string {
  if (flavour === "row" && type.kind === "date" && typeof value === "string" && isIsoDate(value)) return `new Date(${str(value)})`;
  if (flavour === "row" && type.kind === "bigint" && typeof value === "number") return `${litSource(value)}n`;
  return litSource(value);
}

/** Source of an arbitrary for one field under a constraint (or unconstrained when `c` is null). */
export function constrainedArbitrary(type: ValueType, c: FieldConstraint | null, flavour: "wire" | "row"): SourceResult {
  if (!c) {
    const src = arbitrarySource(type, flavour);
    return src ? { ok: true, src } : { ok: false, reason: `no arbitrary for ${type.kind} field ${type.hint ?? ""}`.trim() };
  }
  if (c.isNull === true) return { ok: true, src: "fc.constant(null)" };
  if (c.eq !== undefined) return { ok: true, src: `fc.constant(${literalFor(c.eq, type, flavour)})` };
  let src: string | null;
  if (c.in) {
    src = `fc.constantFrom(${c.in.map((v) => literalFor(v, type, flavour)).join(", ")})`;
  } else {
    const bounds: { min?: number; max?: number } = {};
    if (c.min) bounds.min = boundNumber(c.min.value, c.min.exclusive, 1, type.kind);
    if (c.max) bounds.max = boundNumber(c.max.value, c.max.exclusive, -1, type.kind);
    if ((c.min || c.max) && !["int", "float", "bigint", "date"].includes(type.kind)) {
      // the literal told us the kind; trust the constraint over the name heuristic
      type = { ...type, kind: typeof c.min?.value === "string" || typeof c.max?.value === "string" ? "date" : "int" };
    }
    const lengths = c.lenMin !== undefined || c.lenMax !== undefined ? { min: c.lenMin ?? 0, max: c.lenMax ?? Math.max(12, (c.lenMin ?? 0) + 4) } : undefined;
    if (lengths) type = { ...type, kind: "string", unique: false }; // an explicit length range leaves no room for a nonce suffix
    src = arbitrarySource(type, flavour, bounds, lengths);
    if (!src) return { ok: false, reason: `no arbitrary for ${type.kind} field ${type.hint ?? ""}`.trim() };
    if (lengths && (type.hint ?? "").toLowerCase().includes("email")) {
      // emailAddress ignores lengths; fall back to a plain string of the right length
      src = arbitrarySource({ ...type, hint: "value" }, flavour, bounds, lengths) as string;
    }
  }
  const excluded = [...c.ne, ...c.notIn];
  if (excluded.length > 0) {
    const checks = excluded.map((v) => `v !== ${literalFor(v, type, flavour)}`).join(" && ");
    src = `${src}.filter((v) => ${checks})`;
  }
  return { ok: true, src };
}

/** `fc.record({...})` source for the owner's input under a conjunction (null = unconstrained). */
export function inputArbitrary(m: ActionModel, conj: Conjunction | null): SourceResult {
  let fields: FieldConstraint[] = [];
  if (conj) {
    const merged = mergeConjunction(conj.filter((a) => a.root === "input"));
    if (!merged.ok) return merged;
    fields = merged.fields;
  }
  const unknown = fields.filter((f) => !m.inputFields.some((i) => i.name === f.field));
  if (unknown.length > 0) return { ok: false, reason: `input field ${unknown.map((u) => u.field).join(", ")} is not in the declared input` };
  const entries: string[] = [];
  for (const f of m.inputFields) {
    const c = fields.find((x) => x.field === f.name) ?? null;
    const r = constrainedArbitrary(f.type, c, "wire");
    if (!r.ok) return r;
    entries.push(`${keySource(f.name)}: ${r.src}`);
  }
  if (entries.length === 0) return { ok: true, src: "fc.constant({})" };
  return { ok: true, src: `fc.record({ ${entries.join(", ")} })` };
}

/** Satisfying conjunction over all analysable tier-1 requires clauses. */
export function satisfyAll(m: ActionModel): { ok: true; conj: Conjunction } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const conj: Conjunction = [];
  for (const c of m.requires) {
    if (c.tier !== "expr") continue;
    const a = m.analyses.get(c.id as ContractId);
    if (!a) continue;
    if (!a.ok) reasons.push(`${c.id}: ${a.reason}`);
    else conj.push(...a.satisfy);
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, conj };
}

/** Conjunction violating exactly `target` while satisfying every other analysable tier-1 requires clause. */
export function violateOne(m: ActionModel, target: ContractNode): { ok: true; conj: Conjunction } | { ok: false; reason: string } {
  const a = m.analyses.get(target.id as ContractId);
  if (!a) return { ok: false, reason: "not a tier-1 clause" };
  if (!a.ok) return { ok: false, reason: a.reason };
  const conj: Conjunction = [...a.violate];
  for (const c of m.requires) {
    if (c.id === target.id || c.tier !== "expr") continue;
    const other = m.analyses.get(c.id as ContractId);
    if (other?.ok) conj.push(...other.satisfy);
  }
  const merged = mergeConjunction(conj);
  if (!merged.ok) return { ok: false, reason: `violating ${target.clause} contradicts another clause (${merged.reason})` };
  return { ok: true, conj };
}
