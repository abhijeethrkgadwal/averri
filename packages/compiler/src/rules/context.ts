/**
 * Shared context and helpers for the diagnostic rules (SPEC-DIAGNOSTICS §6): every rule is a pure
 * function `(ctx) => Diagnostic[]` over the assembled build state.
 */

import type { Diagnostic, EntityId, EntityNode, FieldNode, Graph, Node, NodeId, SourceRange } from "@averri/ir";
import { entityId, fieldId } from "@averri/ir";
import type { ContractFacts, DeclFacts, ZodFieldType } from "../model.js";
import type { BuildState } from "../state.js";
import { editDistance } from "../util.js";
import type { VerifyOutput } from "../verify/index.js";

export interface RuleContext {
  state: BuildState;
  verify: VerifyOutput;
  /** The previous build (A1002). */
  previous: Graph | null;
  /** The snapshot pinned by last-green.json (A3002 rename fixes). */
  lastGreen: Graph | null;
  /** Declarations whose input drifts from the schema facts (zod-match fails). Rules add to it. */
  zodDrift: Set<NodeId>;
}

export type Rule = (ctx: RuleContext) => Diagnostic[];

export function nodeOf<T extends Node = Node>(state: BuildState, id: NodeId): T | null {
  return (state.nodes.get(id) as T | undefined) ?? null;
}

export function fieldOf(state: BuildState, entity: EntityId, name: string): FieldNode | null {
  const n = state.nodes.get(fieldId(entity, name));
  return n && n.kind === "Field" ? (n as FieldNode) : null;
}

export function fieldsOf(state: BuildState, entity: EntityId): FieldNode[] {
  const e = state.nodes.get(entity) as EntityNode | undefined;
  if (!e || e.kind !== "Entity") return [];
  return e.fields.map((f) => state.nodes.get(f)).filter((f): f is FieldNode => !!f && f.kind === "Field");
}

export interface PathResolution {
  /** The field the full path ends at, when every segment resolved. */
  field: FieldNode | null;
  /** Index of the first segment that did not resolve (or -1). */
  failedAt: number;
  /** Entity in which the failing segment was looked up. */
  entityAt: EntityId | null;
  /** Index of a non-final segment that crosses a `list: true` relation (or -1). */
  crossesListAt: number;
}

/** Walk dotted segments through relation Fields starting at `entity`. */
export function resolvePath(state: BuildState, entity: EntityId, segments: readonly string[]): PathResolution {
  let current: EntityId | null = entity;
  let crossesListAt = -1;
  for (let i = 0; i < segments.length; i++) {
    if (!current) return { field: null, failedAt: i, entityAt: null, crossesListAt };
    const f = fieldOf(state, current, segments[i] as string);
    if (!f) return { field: null, failedAt: i, entityAt: current, crossesListAt };
    if (i === segments.length - 1) return { field: f, failedAt: -1, entityAt: current, crossesListAt };
    if (f.type.kind !== "relation") return { field: null, failedAt: i + 1, entityAt: null, crossesListAt };
    if (f.type.list && crossesListAt < 0) crossesListAt = i;
    current = f.type.to;
  }
  return { field: null, failedAt: segments.length, entityAt: current, crossesListAt };
}

/** The entity behind `self`/`old` (subject, or the Entity itself for invariants) and `result` (output entity). */
export function rootEntity(state: BuildState, c: ContractFacts, root: string): EntityId | null {
  const owner = state.factsById.get(c.owner);
  if (!owner) return null;
  if (root === "self" || root === "old") {
    if (owner.site.construct === "entity") return c.owner as EntityId;
    return owner.subjectEntity;
  }
  if (root === "result") return owner.outputEntity;
  return null;
}

export function entityByModel(state: BuildState, model: string): EntityId | null {
  return state.entityByClient.get(model) ?? null;
}

export function ownerFacts(state: BuildState, c: ContractFacts): DeclFacts | null {
  return state.factsById.get(c.owner) ?? null;
}

export type TypeCategory = "numeric" | "date" | "string" | "boolean" | "json" | "bytes" | "list" | "relation" | "unknown";

export function fieldCategory(f: FieldNode): TypeCategory {
  const t = f.type;
  if (t.kind === "relation") return t.list ? "list" : "relation";
  if (t.kind === "unsupported") return "unknown";
  if ("list" in t && t.list) return "list";
  if (t.kind === "enum") return "string";
  switch (t.name) {
    case "Int":
    case "Float":
    case "Decimal":
    case "BigInt":
      return "numeric";
    case "DateTime":
      return "date";
    case "String":
      return "string";
    case "Boolean":
      return "boolean";
    case "Json":
      return "json";
    case "Bytes":
      return "bytes";
  }
}

export function zodCategory(z: ZodFieldType): TypeCategory {
  switch (z.kind) {
    case "number":
    case "bigint":
      return "numeric";
    case "date":
      return "date";
    case "string":
    case "enum":
      return "string";
    case "boolean":
      return "boolean";
    case "array":
      return "list";
    default:
      return "unknown";
  }
}

export function isEntity(state: BuildState, id: string): boolean {
  return state.nodes.get(entityId(id))?.kind === "Entity";
}

const ROOTS = ["input", "result", "actor", "self", "old"] as const;

/**
 * A3010 shape: a bare lhs path with >= 2 segments whose first segment is not a root but within edit
 * distance 2 of one (`"reslt.email"`). Returns the closest root, or null. When `fieldsOf` is given, a
 * first segment that is a field of the subject is not a misspelling.
 */
export function misspelledRoot(raw: string, isSubjectField?: (name: string) => boolean): string | null {
  const segs = raw.split(".");
  if (segs.length < 2) return null;
  const first = segs[0] as string;
  if ((ROOTS as readonly string[]).includes(first)) return null;
  if (isSubjectField && isSubjectField(first)) return null;
  let best: string | null = null;
  let bestD = 3;
  for (const r of ROOTS) {
    const d = editDistance(first, r);
    if (d <= 2 && d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}

/** Source range of a `[start, end)` offset span in a project file. */
export function offsetRange(state: BuildState, file: string, start: number, end: number): SourceRange {
  const sf = state.ctx.sourceFile(file);
  if (!sf) return { file, range: [[1, 0], [1, 0]] };
  const a = sf.getLineAndColumnAtPos(start);
  const b = sf.getLineAndColumnAtPos(end);
  return { file, range: [[a.line, a.column - 1], [b.line, b.column - 1]] };
}

export function allContracts(state: BuildState): ContractFacts[] {
  return state.facts.flatMap((f) => f.contracts).filter((c) => state.nodes.has(c.id));
}
