/**
 * fast-check arbitrary SOURCE text per value kind. The generator never runs fast-check itself; it
 * emits calls the generated file makes. Two flavours of every kind exist:
 * - "wire" values: what an HTTP/JSON input can carry (dates as ISO strings, no bigint);
 * - "row" values: what a Prisma `create` accepts (Date objects, bigint).
 */

import type { FieldType, LitScalar } from "@averri/ir";
import { litSource, str } from "./emit.js";

export type ValueKind = "string" | "int" | "float" | "bigint" | "boolean" | "date" | "enum" | "json" | "bytes" | "unsupported";

export interface ValueType {
  kind: ValueKind;
  /** Enum members when `kind === "enum"`. */
  values?: string[];
  /** Name hint of the field (`email`, `url`, `teamId`) used to pick a realistic generator. */
  hint?: string;
  /** Draw unique-ish values (nonce suffix) so `@unique` columns do not collide within a test run. */
  unique?: boolean;
}

export function valueTypeOfField(type: FieldType, name: string, unique = false): ValueType {
  const base: ValueType = { kind: "unsupported", hint: name, unique };
  if (type.kind === "enum") return { ...base, kind: "enum", values: [...type.values] };
  if (type.kind === "relation") return { ...base, kind: "unsupported" };
  if (type.kind === "unsupported") return base;
  switch (type.name) {
    case "String":
      return { ...base, kind: "string" };
    case "Int":
      return { ...base, kind: "int" };
    case "BigInt":
      return { ...base, kind: "bigint" };
    case "Float":
    case "Decimal":
      return { ...base, kind: "float" };
    case "Boolean":
      return { ...base, kind: "boolean" };
    case "DateTime":
      return { ...base, kind: "date" };
    case "Json":
      return { ...base, kind: "json" };
    case "Bytes":
      return { ...base, kind: "bytes" };
  }
}

/** Kind implied by a literal value (null gives `string` so a nullable string stays a string). */
export function valueTypeOfLiteral(value: LitScalar, hint?: string): ValueType {
  if (typeof value === "number") return { kind: Number.isInteger(value) ? "int" : "float", hint };
  if (typeof value === "boolean") return { kind: "boolean", hint };
  if (typeof value === "string" && isIsoDate(value)) return { kind: "date", hint };
  return { kind: "string", hint };
}

/** Guess a kind from a field name alone (the last resort for input fields the graph says nothing about). */
export function valueTypeOfName(name: string): ValueType {
  const n = name.toLowerCase();
  if (n === "email" || n.endsWith("email")) return { kind: "string", hint: name };
  if (n.endsWith("at") && n.length > 2) return { kind: "date", hint: name };
  if (/^(is|has|can|should)[A-Z_]/.test(name) || n === "enabled" || n === "active") return { kind: "boolean", hint: name };
  if (/(count|quantity|amount|age|limit|offset|page|size|total)$/i.test(name)) return { kind: "int", hint: name };
  return { kind: "string", hint: name };
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(s) && !Number.isNaN(Date.parse(s));
}

export const RECENT_DATE_MIN = "2024-01-01T00:00:00.000Z";
export const RECENT_DATE_MAX = "2026-12-31T00:00:00.000Z";

export interface NumericBounds {
  min?: number;
  max?: number;
}

function stringArb(type: ValueType, minLength = 1, maxLength = 12): string {
  const hint = (type.hint ?? "").toLowerCase();
  if (hint === "email" || hint.endsWith("email")) {
    return type.unique ? "fc.emailAddress().map((v) => `${nonce()}.${v}`)" : "fc.emailAddress()";
  }
  if (hint === "url" || hint.endsWith("url")) return "fc.webUrl()";
  const re = `/^[a-z0-9]{${minLength},${maxLength}}$/`;
  return type.unique ? `fc.stringMatching(${re}).map((v) => \`\${v}_\${nonce()}\`)` : `fc.stringMatching(${re})`;
}

/**
 * Source of an arbitrary producing a value of `type` for the wire (HTTP input) or a row (Prisma).
 * Returns null for kinds no arbitrary can produce (`json`, `bytes`, `unsupported`); callers emit a todo.
 */
export function arbitrarySource(type: ValueType, flavour: "wire" | "row", bounds: NumericBounds = {}, lengths?: { min?: number; max?: number }): string | null {
  switch (type.kind) {
    case "string":
      return stringArb(type, lengths?.min ?? 1, lengths?.max ?? 12);
    case "int": {
      const min = bounds.min ?? 0;
      const max = bounds.max ?? Math.max(min, 1_000_000);
      const base = `fc.integer({ min: ${litSource(min)}, max: ${litSource(max)} })`;
      return type.unique ? `${base}.map((v) => (v % 1000) + nonceInt() * 1000)` : base;
    }
    case "float": {
      const min = bounds.min ?? 0;
      const max = bounds.max ?? Math.max(min, 1_000_000);
      return `fc.double({ min: ${litSource(min)}, max: ${litSource(max)}, noNaN: true, noDefaultInfinity: true })`;
    }
    case "bigint": {
      const min = bounds.min ?? 0;
      const max = bounds.max ?? Math.max(min, 1_000_000);
      if (flavour === "wire") return `fc.integer({ min: ${litSource(min)}, max: ${litSource(max)} })`;
      return `fc.bigInt({ min: ${litSource(min)}n, max: ${litSource(max)}n })`;
    }
    case "boolean":
      return "fc.boolean()";
    case "date": {
      const min = bounds.min !== undefined ? new Date(bounds.min).toISOString() : RECENT_DATE_MIN;
      const max = bounds.max !== undefined ? new Date(bounds.max).toISOString() : RECENT_DATE_MAX;
      const base = `fc.date({ min: new Date(${str(min)}), max: new Date(${str(max)}), noInvalidDate: true })`;
      return flavour === "wire" ? `${base}.map((d) => d.toISOString())` : base;
    }
    case "enum": {
      const values = type.values ?? [];
      if (values.length === 0) return null;
      return `fc.constantFrom(${values.map((v) => str(v)).join(", ")})`;
    }
    default:
      return null;
  }
}
