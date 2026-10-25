/**
 * Prisma schema extraction (`@mrleebo/prisma-ast`, never the DMMF): one Entity node per `model`,
 * one Field node per field, `contains` edges Entity -> Field, `persistedBy` edges Entity -> Module
 * and `contains` edges Module -> Entity, plus relation facts the compiler uses for `where` path checks.
 *
 * Confidence: models and fields read from the schema are 0.98. A field whose type names neither a
 * scalar, an enum, a model nor `Unsupported(...)` becomes `{ kind: "unsupported" }` at 0.9 with a
 * `prisma-unknown-type` warning. Evidence is always `kind: "schema"` with the block/field line.
 *
 * Positions are computed from the schema text (the parser is run without location tracking), so an
 * Entity's `src` is the `model X {` ... `}` block and a Field's `src` is its line.
 */

import type { Attribute, BlockAttribute, Field as AstField, Model, Schema, Value } from "@mrleebo/prisma-ast";
// ESM build by path: the CJS `main` cannot load the ESM-only chevrotain under Node/tsx (see prisma-ast-esm.d.ts).
import { getSchema } from "@mrleebo/prisma-ast/dist/prisma-ast.esm.js";
import {
  entityId,
  fieldId,
  moduleId,
  type Edge,
  type EntityId,
  type EntityNode,
  type Evidence,
  type FieldId,
  type FieldNode,
  type FieldType,
  type ModuleNode,
  type Position,
  type PrismaScalar,
  type SourceRange,
} from "@averri/ir";
import type { ExtractWarning, PrismaFacts, PrismaRelationFact } from "./types.js";
import { countLines, extracted, sha256, summary, uncapitalize } from "./util.js";

const PRISMA_SCALARS: ReadonlySet<string> = new Set<PrismaScalar>([
  "String",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "Boolean",
  "DateTime",
  "Json",
  "Bytes",
]);

export const PRISMA_CONFIDENCE = { model: 0.98, field: 0.98, unknownType: 0.9 } as const;

export interface PrismaExtraction {
  nodes: Array<EntityNode | FieldNode>;
  edges: Edge[];
  module: ModuleNode;
  facts: PrismaFacts;
  warnings: ExtractWarning[];
}

/**
 * Extract Entity/Field nodes from the text of a Prisma schema.
 * @param source   schema text
 * @param file     repo-relative POSIX path of the schema (used for ids, `src` and the Module node)
 */
export function extractPrismaSchema(source: string, file: string): PrismaExtraction {
  const warnings: ExtractWarning[] = [];
  let schema: Schema;
  try {
    schema = getSchema(source);
  } catch (err) {
    warnings.push({ code: "prisma-parse-error", message: `cannot parse ${file}: ${(err as Error).message}`, file });
    schema = { type: "schema", list: [] };
  }
  const lines = source.split("\n");
  const locator = new BlockLocator(lines);

  const enums = new Map<string, string[]>();
  for (const block of schema.list) {
    if (block.type !== "enum") continue;
    const values: string[] = [];
    for (const e of block.enumerators) if (e.type === "enumerator") values.push(e.name);
    enums.set(block.name, values);
  }

  const models: Model[] = [];
  const seen = new Set<string>();
  for (const block of schema.list) {
    if (block.type === "view") {
      warnings.push({ code: "prisma-view-skipped", message: `view ${block.name} is not extracted as an Entity (V0 covers models only)`, file });
      continue;
    }
    if (block.type !== "model") continue;
    if (seen.has(block.name)) {
      warnings.push({ code: "prisma-duplicate-model", message: `model ${block.name} is declared twice; the first declaration is kept`, file });
      continue;
    }
    seen.add(block.name);
    models.push(block);
  }
  const modelNames = new Set(models.map((m) => m.name));

  const nodes: Array<EntityNode | FieldNode> = [];
  const edges: Edge[] = [];
  const relations: PrismaRelationFact[] = [];
  const modId = moduleId(file);

  for (const model of models) {
    const eid = entityId(model.name);
    const blockRange = locator.modelRange(model.name, file);
    const fields = model.properties.filter((p): p is AstField => p.type === "field");
    const blockAttrs = model.properties.filter((p): p is BlockAttribute => p.type === "attribute");

    const compoundId = firstArray(blockAttrs.find((a) => a.name === "id"));
    const compoundUniques = blockAttrs.filter((a) => a.name === "unique").map((a) => firstArray(a));
    const idFields: string[] = [];
    const uniques: string[][] = [];
    const fieldIds: FieldId[] = [];
    const fieldNodes: FieldNode[] = [];

    for (const f of fields) {
      const attrs = f.attributes ?? [];
      const has = (name: string) => attrs.some((a) => a.name === name);
      const isId = has("id") || compoundId.includes(f.name);
      const unique = has("unique") || compoundUniques.some((g) => g.length === 1 && g[0] === f.name);
      const hasDefault = has("default");
      if (has("id")) idFields.push(f.name);
      if (has("unique")) uniques.push([f.name]);

      const typed = fieldTypeOf(f, enums, modelNames, eid);
      let confidence: number = PRISMA_CONFIDENCE.field;
      if (typed.unknown) {
        confidence = PRISMA_CONFIDENCE.unknownType;
        warnings.push({
          code: "prisma-unknown-type",
          message: `${model.name}.${f.name} has type ${typed.raw}, which is not a scalar, enum or model`,
          file,
        });
      }
      const fieldRange = locator.fieldRange(model.name, f.name, file) ?? blockRange;
      const fid = fieldId(eid, f.name);
      const evidence: Evidence[] = [
        { kind: "schema", note: `${model.name}.${f.name} ${describeField(f)} at ${file}:${fieldRange.range[0][0]}`, src: fieldRange },
      ];
      const relation = attrs.find((a) => a.name === "relation");
      if (typed.type.kind === "relation") {
        relations.push({
          from: eid,
          field: f.name,
          to: typed.type.to,
          list: typed.type.list,
          optional: f.optional === true,
          fields: relation ? keyValueArray(relation, "fields") : [],
          references: relation ? keyValueArray(relation, "references") : [],
          name: relation ? relationName(relation) : null,
        });
      }
      const node: FieldNode = {
        id: fid,
        kind: "Field",
        name: `${model.name}.${f.name}`,
        summary: summary(`${model.name}.${f.name}: ${renderFieldType(typed.type)}${f.optional ? "?" : ""}${isId ? " @id" : ""}${unique ? " @unique" : ""}${hasDefault ? " @default" : ""}`),
        provenance: extracted("prisma", confidence, evidence),
        src: fieldRange,
        entity: eid,
        type: typed.type,
        optional: f.optional === true,
        isId,
        unique,
        hasDefault,
      };
      fieldNodes.push(node);
      fieldIds.push(fid);
    }
    if (compoundId.length > 0) idFields.push(...compoundId.filter((n) => !idFields.includes(n)));
    for (const g of compoundUniques) if (g.length > 0) uniques.push(g);

    const relationCount = fieldNodes.filter((n) => n.type.kind === "relation").length;
    const entityEvidence: Evidence[] = [
      { kind: "schema", note: `model ${model.name} at ${file}:${blockRange.range[0][0]} (${fields.length} fields)`, src: blockRange },
    ];
    const entity: EntityNode = {
      id: eid,
      kind: "Entity",
      name: model.name,
      summary: summary(
        `Prisma model ${model.name} · ${fields.length} fields (${relationCount} relations) · id ${idFields.join("+") || "none"}${uniques.length ? ` · unique ${uniques.map((u) => u.join("+")).join(", ")}` : ""}`,
      ),
      provenance: extracted("prisma", PRISMA_CONFIDENCE.model, entityEvidence),
      src: blockRange,
      model: model.name,
      clientName: uncapitalize(model.name),
      fields: fieldIds,
      idFields,
      uniques,
      invariants: [],
    };
    nodes.push(entity, ...fieldNodes);
    edges.push({ kind: "contains", from: modId, to: eid, provenance: extracted("prisma", PRISMA_CONFIDENCE.model, entityEvidence) });
    edges.push({
      kind: "persistedBy",
      from: eid,
      to: modId,
      provenance: extracted("prisma", PRISMA_CONFIDENCE.model, entityEvidence),
      attrs: { model: entity.clientName },
    });
    for (const fn of fieldNodes) {
      edges.push({ kind: "contains", from: eid, to: fn.id, provenance: extracted("prisma", PRISMA_CONFIDENCE.field, fn.provenance.origin === "extracted" ? fn.provenance.evidence : []) });
    }
  }

  const moduleNode: ModuleNode = {
    id: modId,
    kind: "Module",
    name: file,
    summary: summary(`Prisma schema · ${models.length} models · ${enums.size} enums`),
    provenance: extracted("prisma", 1, [{ kind: "schema", note: `Prisma schema ${file}` }]),
    src: null,
    file,
    role: "prisma-schema",
    exports: [...models.map((m) => m.name), ...enums.keys()],
    hash: sha256(source),
    lines: countLines(source),
  };

  const enumsRecord: Record<string, string[]> = {};
  for (const [k, v] of enums) enumsRecord[k] = v;
  return {
    nodes,
    edges,
    module: moduleNode,
    facts: { file, models: models.map((m) => m.name), enums: enumsRecord, relations },
    warnings,
  };
}

// --- helpers -------------------------------------------------------------------

interface TypedField {
  type: FieldType;
  unknown: boolean;
  raw: string;
}

function fieldTypeOf(f: AstField, enums: Map<string, string[]>, models: Set<string>, _owner: EntityId): TypedField {
  const list = f.array === true;
  const ft = f.fieldType;
  if (typeof ft !== "string") {
    const params = (ft.params ?? []).map(renderValue).join(", ");
    const raw = `${ft.name}(${params})`;
    if (ft.name === "Unsupported") return { type: { kind: "unsupported", raw }, unknown: false, raw };
    return { type: { kind: "unsupported", raw }, unknown: true, raw };
  }
  if (PRISMA_SCALARS.has(ft)) return { type: { kind: "scalar", name: ft as PrismaScalar, list }, unknown: false, raw: ft };
  const enumValues = enums.get(ft);
  if (enumValues) return { type: { kind: "enum", name: ft, values: enumValues, list }, unknown: false, raw: ft };
  if (models.has(ft)) return { type: { kind: "relation", to: entityId(ft), list }, unknown: false, raw: ft };
  return { type: { kind: "unsupported", raw: ft }, unknown: true, raw: ft };
}

export function renderFieldType(t: FieldType): string {
  switch (t.kind) {
    case "scalar":
      return `${t.name}${t.list ? "[]" : ""}`;
    case "enum":
      return `${t.name}${t.list ? "[]" : ""} (enum)`;
    case "relation":
      return `${t.to.slice("Entity:".length)}${t.list ? "[]" : ""} (relation)`;
    case "unsupported":
      return t.raw;
  }
}

function describeField(f: AstField): string {
  const base = typeof f.fieldType === "string" ? f.fieldType : `${f.fieldType.name}(...)`;
  return `${base}${f.array ? "[]" : ""}${f.optional ? "?" : ""}`;
}

function renderValue(v: Value): string {
  if (v === null) return "null";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return `[${v.map(renderValue).join(", ")}]`;
  if (v.type === "function") return `${v.name}(${(v.params ?? []).map(renderValue).join(", ")})`;
  if (v.type === "array") return `[${v.args.map(renderValue).join(", ")}]`;
  return `{${v.properties.map((p) => `${p.key}: ${renderValue(p.value)}`).join(", ")}}`;
}

/** First array argument of a block attribute (`@@id([a, b])`), as field names. */
function firstArray(attr: Attribute | BlockAttribute | undefined): string[] {
  if (!attr) return [];
  for (const arg of attr.args ?? []) {
    const v = arg.value;
    if (v && typeof v === "object" && !Array.isArray(v) && v.type === "array") return v.args.map(renderValue);
    if (v && typeof v === "object" && !Array.isArray(v) && v.type === "keyValue" && v.key === "fields") {
      const inner = v.value;
      if (inner && typeof inner === "object" && !Array.isArray(inner) && inner.type === "array") return inner.args.map(renderValue);
    }
  }
  return [];
}

function keyValueArray(attr: Attribute, key: string): string[] {
  for (const arg of attr.args ?? []) {
    const v = arg.value;
    if (v && typeof v === "object" && !Array.isArray(v) && v.type === "keyValue" && v.key === key) {
      const inner = v.value;
      if (inner && typeof inner === "object" && !Array.isArray(inner) && inner.type === "array") return inner.args.map(renderValue);
    }
  }
  return [];
}

function relationName(attr: Attribute): string | null {
  for (const arg of attr.args ?? []) {
    const v = arg.value;
    if (typeof v === "string" && v.startsWith('"')) return v.slice(1, -1);
    if (v && typeof v === "object" && !Array.isArray(v) && v.type === "keyValue" && v.key === "name" && typeof v.value === "string") {
      return v.value.replace(/^"|"$/g, "");
    }
  }
  return null;
}

/** Finds `model X { ... }` blocks and field lines in the schema text. Lines are 1-based. */
class BlockLocator {
  private readonly blocks = new Map<string, { start: number; end: number; headerCol: number }>();

  constructor(private readonly lines: string[]) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(model|view|type)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(lines[i]!);
      if (!m) continue;
      let end = i;
      for (let j = i; j < lines.length; j++) {
        if (/^\s*\}\s*$/.test(lines[j]!)) {
          end = j;
          break;
        }
      }
      if (!this.blocks.has(m[3]!)) this.blocks.set(m[3]!, { start: i + 1, end: end + 1, headerCol: m[1]!.length });
    }
  }

  modelRange(model: string, file: string): SourceRange {
    const b = this.blocks.get(model);
    if (!b) return { file, range: [[1, 0], [1, 0]] };
    const endLine = this.lines[b.end - 1] ?? "";
    const endCol = Math.max(endLine.indexOf("}") + 1, 0);
    const start: Position = [b.start, b.headerCol];
    const end: Position = [b.end, endCol];
    return { file, range: [start, end] };
  }

  fieldRange(model: string, field: string, file: string): SourceRange | null {
    const b = this.blocks.get(model);
    if (!b) return null;
    const re = new RegExp(`^(\\s*)${escapeRe(field)}\\s`);
    for (let i = b.start; i < b.end - 1; i++) {
      const line = this.lines[i] ?? "";
      const m = re.exec(line);
      if (!m) continue;
      const trimmedEnd = line.replace(/\s+$/, "").length;
      return { file, range: [[i + 1, m[1]!.length], [i + 1, trimmedEnd]] };
    }
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
