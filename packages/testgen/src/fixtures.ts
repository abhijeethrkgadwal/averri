/**
 * Fixture synthesis from schema facts (SPEC-CONTRACTS §9, "Fixture synthesis for tier 2 predicates").
 *
 * A predicate over `model` with a flat `where` becomes an emitted async function that creates the row
 * satisfying `where` (refs resolved from the generated input/actor at test time, literals as given),
 * draws every other required field with fast-check, creates required to-one parents first (depth <= 3)
 * and, in `falsify` mode, alters the first `where` key. Unsupported shapes return a reason and the
 * caller emits `it.todo(reason)`.
 */

import {
  isLit,
  isRef,
  refRoot,
  refSegments,
  whereLeaves,
  type DbWhere,
  type EntityNode,
  type FieldNode,
  type LitScalar,
  type Ref,
  type WhereLeaf,
} from "@averri/ir";
import { arbitrarySource, isIsoDate, valueTypeOfField, type ValueType } from "./arbitraries.js";
import { constrainedArbitrary, type SourceResult } from "./model.js";
import type { FieldConstraint } from "./constraints.js";
import { ident, keySource, litSource, str } from "./emit.js";
import type { SchemaFacts } from "./schema.js";

export const MAX_RELATION_DEPTH = 3;

// ---------------------------------------------------------------------------
// Value sources
// ---------------------------------------------------------------------------

/** Runtime source reading a ref from `env` (`input.*` and `actor.*` only). */
export function refSource(ref: Ref): SourceResult {
  const root = refRoot(ref.ref);
  const segs = refSegments(ref.ref);
  if (segs.length === 0) return { ok: false, reason: `malformed ref ${ref.ref}` };
  if (root === "input") {
    return { ok: true, src: segs.length === 1 ? `env.input[${str(segs[0] as string)}]` : `get(env.input, ${litSource(segs)})` };
  }
  if (root === "actor") {
    const head = `actorField(env, ${str(segs[0] as string)})`;
    return { ok: true, src: segs.length === 1 ? head : `get(${head}, ${litSource(segs.slice(1))})` };
  }
  return { ok: false, reason: `where references ${root ?? "?"}.* which fixtures cannot resolve` };
}

function rowLiteral(value: LitScalar, field: FieldNode | null): string {
  const t = field ? valueTypeOfField(field.type, field.name) : null;
  if (t?.kind === "date" && typeof value === "string" && isIsoDate(value)) return `new Date(${str(value)})`;
  if (t?.kind === "bigint" && typeof value === "number") return `${litSource(value)}n`;
  return litSource(value);
}

/** A literal that differs from `value` (same type where possible). */
export function alteredLiteral(value: LitScalar): LitScalar {
  if (typeof value === "string") return `${value}_x`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  return "altered";
}

/** A literal outside `values`, or null when the list exhausts its type (both booleans). */
export function notInSample(values: LitScalar[]): LitScalar | null {
  const nonNull = values.filter((v) => v !== null);
  const first = nonNull[0];
  if (first === undefined) return "x";
  if (typeof first === "boolean") {
    if (!values.includes(true)) return true;
    if (!values.includes(false)) return false;
    return null;
  }
  if (typeof first === "number") return Math.max(...nonNull.map((v) => (typeof v === "number" ? v : 0))) + 1;
  let candidate = `${String(first)}_x`;
  while (values.includes(candidate)) candidate += "_x";
  return candidate;
}

/** `alteredLiteral`, but a DateTime column gets the next day instead of a non-date string. */
function alteredRowLiteral(value: LitScalar, field: FieldNode | null, domain: readonly LitScalar[] | null = null): string {
  const t = field ? valueTypeOfField(field.type, field.name) : null;
  // a closed column domain (entity invariant `in`) supplies an in-domain alternative
  const alt = domain?.find((d) => d !== value && d !== null);
  if (alt !== undefined) return rowLiteral(alt, field);
  // `null` becomes a drawn value of the column's type (never a string in a DateTime column)
  if (value === null && t !== null) {
    const src = arbitrarySource(t, "row");
    if (src) return `draw(${src})`;
  }
  if (t?.kind === "date" && typeof value === "string" && isIsoDate(value)) return `new Date(${str(new Date(Date.parse(value) + 86_400_000).toISOString())})`;
  return rowLiteral(alteredLiteral(value), field);
}

function operandSource(value: WhereLeaf["value"], field: FieldNode | null): SourceResult {
  if (isRef(value)) return refSource(value);
  if (isLit(value)) {
    if (Array.isArray(value.lit)) return { ok: false, reason: "list literal outside `in`" };
    return { ok: true, src: rowLiteral(value.lit, field) };
  }
  return { ok: false, reason: "`len` operands inside where are not supported by fixtures" };
}

export interface LeafSources {
  satisfy: string;
  falsify: string;
}

/** Sources of a value for the leaf's key that make the leaf true (`satisfy`) and false (`falsify`). */
export function leafSources(leaf: WhereLeaf, field: FieldNode | null, domain: readonly LitScalar[] | null = null): LeafSources | { reason: string } {
  const v = leaf.value;
  switch (leaf.operator) {
    case null: {
      const s = operandSource(v, field);
      if (!s.ok) return { reason: s.reason };
      if (isLit(v) && !Array.isArray(v.lit)) return { satisfy: s.src, falsify: alteredRowLiteral(v.lit, field, domain) };
      return { satisfy: s.src, falsify: `altered(${s.src})` };
    }
    case "in": {
      if (!isLit(v) || !Array.isArray(v.lit)) return { reason: "`in` over a ref list is not supported by fixtures" };
      const first = v.lit[0];
      if (first === undefined) return { reason: "`in` over an empty list" };
      const list = v.lit;
      const inDomain = domain?.find((d) => !list.includes(d));
      const out = inDomain !== undefined ? inDomain : domain ? null : notInSample(v.lit);
      if (out === null) return { reason: "`in` list covers every value of its type" };
      return { satisfy: rowLiteral(first, field), falsify: rowLiteral(out, field) };
    }
    case "not": {
      const s = operandSource(v, field);
      if (!s.ok) return { reason: s.reason };
      const satisfy = isLit(v) && !Array.isArray(v.lit) ? alteredRowLiteral(v.lit, field) : `altered(${s.src})`;
      return { satisfy, falsify: s.src };
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const s = operandSource(v, field);
      if (!s.ok) return { reason: s.reason };
      const below = `bump(${s.src}, -1)`;
      const above = `bump(${s.src}, 1)`;
      if (leaf.operator === "lt") return { satisfy: below, falsify: s.src };
      if (leaf.operator === "lte") return { satisfy: s.src, falsify: above };
      if (leaf.operator === "gt") return { satisfy: above, falsify: s.src };
      return { satisfy: s.src, falsify: below };
    }
  }
}

// ---------------------------------------------------------------------------
// Row plans
// ---------------------------------------------------------------------------

export interface RowRequest {
  entity: EntityNode;
  /** Flat pins: scalar field name or dotted relation path -> runtime source expression. */
  pins: ReadonlyMap<string, string>;
  /** `ensure` finds the row by its pinned id before creating (parents referenced by a pinned FK). */
  how: "create" | "ensure";
  varName: string;
  depth: number;
  visiting: ReadonlySet<string>;
}

export interface RowCode {
  statements: string[];
  resultVar: string;
  /** Every row variable created (parents included), for `void` lines that keep `noUnusedLocals` quiet. */
  vars: string[];
}

export type RowResult = { ok: true; code: RowCode } | { ok: false; reason: string };

function drawSource(field: FieldNode, constraint: FieldConstraint | null = null): SourceResult {
  const type: ValueType = valueTypeOfField(field.type, field.name, field.unique || field.isId);
  if (field.type.kind === "scalar" && field.type.list) return { ok: true, src: "[]" };
  if (constraint !== null) {
    const arb = constrainedArbitrary(type, constraint, "row");
    if (arb.ok) return { ok: true, src: `draw(${arb.src})` };
  }
  const src = arbitrarySource(type, "row");
  if (!src) return { ok: false, reason: `${field.entity.slice("Entity:".length)}.${field.name} (${describeType(field)}) cannot be synthesised` };
  return { ok: true, src: `draw(${src})` };
}

function describeType(field: FieldNode): string {
  const t = field.type;
  if (t.kind === "scalar") return t.name;
  if (t.kind === "enum") return `enum ${t.name}`;
  if (t.kind === "relation") return `relation ${t.to}`;
  return `Unsupported(${t.raw})`;
}

export function planRow(facts: SchemaFacts, req: RowRequest): RowResult {
  const { entity } = req;
  if (req.depth > MAX_RELATION_DEPTH) return { ok: false, reason: `relation depth exceeds ${MAX_RELATION_DEPTH} at ${entity.model}` };
  if (req.visiting.has(entity.id)) return { ok: false, reason: `relation cycle through ${entity.model}` };
  if (entity.idFields.length > 1) return { ok: false, reason: `${entity.model} has a compound primary key` };
  const idField = facts.singleIdField(entity);
  const visiting = new Set(req.visiting);
  visiting.add(entity.id);

  const scalarPins = new Map<string, string>();
  const relationPins = new Map<string, Map<string, string>>();
  for (const [key, src] of req.pins) {
    const dot = key.indexOf(".");
    if (dot < 0) {
      scalarPins.set(key, src);
      continue;
    }
    const rel = key.slice(0, dot);
    const rest = key.slice(dot + 1);
    const m = relationPins.get(rel) ?? new Map<string, string>();
    m.set(rest, src);
    relationPins.set(rel, m);
  }

  const statements: string[] = [];
  const vars: string[] = [];
  const data = new Map<string, string>();
  const fkHandled = new Set<string>();

  for (const field of facts.fields(entity)) {
    if (field.type.kind !== "relation") continue;
    const pinsForRel = relationPins.get(field.name);
    if (field.type.list) {
      if (pinsForRel) return { ok: false, reason: `where path ${field.name}.* crosses a list relation` };
      continue;
    }
    if (field.optional && !pinsForRel) continue;
    const parentEntity = facts.entity(field.type.to);
    if (!parentEntity) return { ok: false, reason: `relation ${entity.model}.${field.name} targets an unknown entity` };
    const fk = facts.fkFieldFor(entity, field);
    if (!fk) return { ok: false, reason: `relation ${entity.model}.${field.name} has no derivable foreign-key scalar` };
    const parentId = facts.singleIdField(parentEntity);
    if (!parentId) return { ok: false, reason: `${parentEntity.model} has no single-field primary key` };
    const parentPins = new Map<string, string>(pinsForRel ?? []);
    const pinnedFk = scalarPins.get(fk.name);
    let how: "create" | "ensure" = "create";
    if (pinnedFk !== undefined) {
      parentPins.set(parentId.name, pinnedFk);
      how = "ensure";
    } else if (parentPins.has(parentId.name)) {
      how = "ensure";
    }
    const parent = planRow(facts, {
      entity: parentEntity,
      pins: parentPins,
      how,
      varName: `${req.varName}_${ident(field.name)}`,
      depth: req.depth + 1,
      visiting,
    });
    if (!parent.ok) return parent;
    statements.push(...parent.code.statements);
    vars.push(...parent.code.vars);
    data.set(fk.name, pinnedFk ?? `${parent.code.resultVar}[${str(parentId.name)}]`);
    fkHandled.add(fk.name);
  }

  for (const field of facts.fields(entity)) {
    if (field.type.kind === "relation" || fkHandled.has(field.name)) continue;
    const pinned = scalarPins.get(field.name);
    if (pinned !== undefined) {
      data.set(field.name, pinned);
      continue;
    }
    const required = !field.optional && !field.hasDefault;
    if (!required) continue;
    if (field.type.kind === "unsupported") return { ok: false, reason: `${entity.model}.${field.name} is Unsupported(${field.type.raw})` };
    const d = drawSource(field, facts.columnConstraint(entity, field.name));
    if (!d.ok) return d;
    data.set(field.name, d.src);
  }
  for (const key of scalarPins.keys()) {
    if (!facts.field(entity, key)) return { ok: false, reason: `${entity.model} has no field ${key}` };
  }

  const entries = [...data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${keySource(k)}: ${v}`);
  const dataSrc = `{ ${entries.join(", ")} }`;
  const client = `model(h, ${str(entity.clientName)})`;
  const idPin = idField ? scalarPins.get(idField.name) : undefined;
  // Pinned values that cover the primary key or a unique constraint can name a row that already
  // exists (a fixture actor's own membership, a seeded key): update it in place instead of colliding.
  const pinnedKeys = scalarPins; // pinned foreign keys are scalar pins too
  const uniqueKey = [...(idField ? [[idField.name]] : []), ...entity.uniques].find((u) => u.length > 0 && u.every((f) => pinnedKeys.has(f)));
  if (req.how === "ensure" && idField && idPin !== undefined) {
    statements.push(`const ${req.varName} = await ensureRow(${client}, { ${keySource(idField.name)}: ${idPin} }, ${dataSrc});`);
  } else if (req.how === "create" && req.depth === 0 && uniqueKey) {
    const keySrc = `{ ${[...uniqueKey].sort().map((f) => `${keySource(f)}: ${pinnedKeys.get(f) as string}`).join(", ")} }`;
    const pinSrc = `{ ${[...pinnedKeys.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${keySource(k)}: ${v}`).join(", ")} }`;
    statements.push(`const ${req.varName} = await ensurePinned(${client}, ${keySrc}, ${pinSrc}, ${dataSrc});`);
  } else {
    statements.push(`const ${req.varName} = await ${client}.create({ data: ${dataSrc} });`);
  }
  vars.push(req.varName);
  return { ok: true, code: { statements, resultVar: req.varName, vars } };
}

// ---------------------------------------------------------------------------
// Predicate seeds
// ---------------------------------------------------------------------------

export interface SeedFunction {
  name: string;
  code: string;
}

export type SeedResult = { ok: true; fn: SeedFunction } | { ok: false; reason: string };

/**
 * Emit `async function <name>(h, env, mode)` that makes `op` over `model`/`where` true (`satisfy`) or
 * false (`falsify`). `db.none` is satisfied by creating nothing and falsified by creating a matching row.
 */
export function planPredicateSeed(facts: SchemaFacts, name: string, op: "db.exists" | "db.none" | "db.unique" | "db.countWhere", model: string, where: DbWhere): SeedResult {
  if (op === "db.countWhere") return { ok: false, reason: "db.countWhere fixtures (row counts) are not derivable" };
  const entity = facts.entityByClient(model);
  if (!entity) return { ok: false, reason: `unknown Prisma model accessor "${model}"` };
  const leaves = whereLeaves(where);
  const keys = Object.keys(where);
  if (keys.length === 0) return { ok: false, reason: "empty where" };
  const pre: string[] = [];
  const pins = new Map<string, string>();
  const planned: Array<{ key: string; s: LeafSources; literal: boolean }> = [];
  for (const key of keys) {
    const resolved = facts.resolveWhereKey(entity, key);
    if (resolved.crossesList) return { ok: false, reason: `where path ${key} crosses a list relation` };
    if (!resolved.field) return { ok: false, reason: `where key ${key} does not resolve to a field of ${entity.model}` };
    const leaf = leaves.find((l) => l.key === key);
    if (!leaf) return { ok: false, reason: `where key ${key} has no analysable value` };
    // closed domain of the column: an entity invariant `in` list, else the Prisma enum's values
    const enumValues = resolved.field.type.kind === "enum" ? resolved.field.type.values : null;
    const domain = key.includes(".") ? null : (facts.columnConstraint(entity, key)?.in ?? enumValues);
    const s = leafSources(leaf, resolved.field, domain);
    if ("reason" in s) return { ok: false, reason: `where key ${key}: ${s.reason}` };
    planned.push({ key, s, literal: !key.includes(".") && isLit(leaf.value) });
  }
  // Falsify a literal-valued column of the row itself when there is one (`deletedAt: null`, `role: "owner"`):
  // the row other seeds need (same refs) is then updated in place rather than duplicated elsewhere (D-40).
  const falsifyAt = Math.max(0, planned.findIndex((x) => x.literal));
  for (const [i, { key, s }] of planned.entries()) {
    const v = `v_${ident(key)}`;
    if (op === "db.none" || i !== falsifyAt) pre.push(`const ${v} = ${s.satisfy};`);
    else pre.push(`const ${v} = mode === "falsify" ? ${s.falsify} : ${s.satisfy};`);
    pins.set(key, v);
  }
  const row = planRow(facts, { entity, pins, how: "create", varName: "row", depth: 0, visiting: new Set() });
  if (!row.ok) return row;
  const body: string[] = [];
  if (op === "db.none") body.push("// db.none holds when no matching row exists; falsifying it means creating one", 'if (mode === "satisfy") return;');
  body.push(...pre, ...row.code.statements, row.code.vars.map((v) => `void ${v};`).join(" "));
  const code = [`async function ${name}(h: AverriTestHarness, env: Env, mode: SeedMode): Promise<void> {`, ...body.map((l) => `  ${l}`), "}"].join("\n");
  return { ok: true, fn: { name, code } };
}

/**
 * A clause constraint restricted to the column's closed domain (entity invariant `in`), so a violating
 * draw of `self.status != "active"` picks another real status rather than an arbitrary string (D-40).
 */
export function withColumnDomain(c: FieldConstraint, column: FieldConstraint | null): FieldConstraint {
  if (column?.in === undefined || c.eq !== undefined || c.isNull === true) return c;
  const excluded = [...c.ne, ...c.notIn];
  const base = c.in ? c.in.filter((v) => column.in?.includes(v)) : column.in;
  const domain = base.filter((v) => !excluded.includes(v));
  return domain.length > 0 ? { ...c, in: domain, ne: [], notIn: [] } : c;
}

/**
 * Emit `async function <name>(h, env)` creating the subject row selected by `where` with the given
 * tier-1 `self.*` constraints applied (null = unconstrained draws).
 */
export function planSubjectSeed(facts: SchemaFacts, name: string, entity: EntityNode, where: DbWhere, constraints: readonly FieldConstraint[]): SeedResult {
  const pins = new Map<string, string>();
  const pre: string[] = [];
  for (const leaf of whereLeaves(where)) {
    if (leaf.operator !== null) return { ok: false, reason: `subject.where key ${leaf.key} uses an operator` };
    const resolved = facts.resolveWhereKey(entity, leaf.key);
    if (!resolved.field) return { ok: false, reason: `subject.where key ${leaf.key} does not resolve to a field of ${entity.model}` };
    const s = operandSource(leaf.value, resolved.field);
    if (!s.ok) return { ok: false, reason: `subject.where key ${leaf.key}: ${s.reason}` };
    const v = `v_${ident(leaf.key)}`;
    pre.push(`const ${v} = ${s.src};`);
    pins.set(leaf.key, v);
  }
  for (const c of constraints) {
    if (pins.has(c.field)) return { ok: false, reason: `self.${c.field} is both selected by subject.where and constrained` };
    const field = facts.field(entity, c.field);
    if (!field || field.type.kind === "relation") return { ok: false, reason: `${entity.model} has no scalar field ${c.field}` };
    const arb = constrainedArbitrary(valueTypeOfField(field.type, field.name, field.unique), withColumnDomain(c, facts.columnConstraint(entity, c.field)), "row");
    if (!arb.ok) return arb;
    const v = `v_${ident(c.field)}`;
    pre.push(`const ${v} = draw(${arb.src});`);
    pins.set(c.field, v);
  }
  const row = planRow(facts, { entity, pins, how: "create", varName: "row", depth: 0, visiting: new Set() });
  if (!row.ok) return row;
  const body = [...pre, ...row.code.statements, row.code.vars.map((v) => `void ${v};`).join(" ")];
  const code = [`async function ${name}(h: AverriTestHarness, env: Env): Promise<void> {`, ...body.map((l) => `  ${l}`), "}"].join("\n");
  return { ok: true, fn: { name, code } };
}
