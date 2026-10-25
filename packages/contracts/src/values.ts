/**
 * Value normalisation and serialisation (SPEC-CONTRACTS §4, §8).
 *
 * Comparison: JS strict comparison after normalisation — `Date` by epoch ms, `Decimal`/`BigInt` by
 * numeric value, `null` only equal to `null`, `undefined` never equal to anything (fail closed).
 * Serialisation: `Date` → ISO string, `Decimal`/`BigInt` → string, `undefined` properties dropped.
 */
import type { Row } from "./types.js";

export function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Prisma `Decimal` (decimal.js) and look-alikes expose `toNumber()`; we never import the class. */
export function isDecimalLike(value: unknown): value is { toNumber(): number; toString(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toNumber?: unknown }).toNumber === "function" &&
    typeof (value as { toString?: unknown }).toString === "function"
  );
}

/**
 * Normalises a value for comparison: `Date` → epoch ms (invalid date → `undefined`), `bigint` →
 * `number`, Decimal-like → `number`. Everything else is returned unchanged.
 */
export function normaliseValue(value: unknown): unknown {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (typeof value === "bigint") return Number(value);
  if (isDecimalLike(value)) {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : undefined;
  }
  return value;
}

/** `eq` semantics. Objects and arrays are never equal (no structural comparison). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  const na = normaliseValue(a);
  const nb = normaliseValue(b);
  if (na === undefined || nb === undefined) return false;
  if (na === null || nb === null) return na === nb;
  if (typeof na !== typeof nb) return false;
  switch (typeof na) {
    case "number":
    case "string":
    case "boolean":
      return na === nb;
    default:
      return false;
  }
}

export type OrderOp = "lt" | "lte" | "gt" | "gte";

/** `lt/lte/gt/gte`: true only when both operands normalise to finite numbers (numbers, dates, decimals, bigints). */
export function compareOrder(op: OrderOp, a: unknown, b: unknown): boolean {
  const na = normaliseValue(a);
  const nb = normaliseValue(b);
  if (typeof na !== "number" || typeof nb !== "number" || !Number.isFinite(na) || !Number.isFinite(nb)) return false;
  switch (op) {
    case "lt":
      return na < nb;
    case "lte":
      return na <= nb;
    case "gt":
      return na > nb;
    case "gte":
      return na >= nb;
  }
}

export type CompareOp = "eq" | "ne" | OrderOp;

export function compareValues(op: CompareOp, a: unknown, b: unknown): boolean {
  switch (op) {
    case "eq":
      return valuesEqual(a, b);
    case "ne": {
      const na = normaliseValue(a);
      const nb = normaliseValue(b);
      if (na === undefined || nb === undefined) return false;
      return !valuesEqual(na, nb);
    }
    default:
      return compareOrder(op, a, b);
  }
}

/**
 * Converts a value to plain JSON data: `Date` → ISO string, `bigint`/Decimal → string, functions and
 * symbols → `undefined` (dropped), `undefined` array elements → `null`. Cycles are cut to `null`.
 */
export function toJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined || value === null) return value;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : value.toISOString();
  }
  if (isDecimalLike(value)) return value.toString();
  if (typeof value === "object") {
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((v) => {
          const j = toJsonValue(v, seen);
          return j === undefined ? null : j;
        });
      }
      const withToJson = value as { toJSON?: unknown };
      if (typeof withToJson.toJSON === "function") {
        return toJsonValue((withToJson.toJSON as () => unknown)(), seen);
      }
      const out: Row = {};
      for (const key of Object.keys(value as Row)) {
        const j = toJsonValue((value as Row)[key], seen);
        if (j !== undefined) out[key] = j;
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return undefined;
}

/** The response body of a successful declared-mode action: {@link toJsonValue}, with a top-level `undefined` becoming `null`. */
export function serializeResult(result: unknown): unknown {
  const json = toJsonValue(result);
  return json === undefined ? null : json;
}

/** Deep copy preserving `Date`s; non-plain objects (Decimal, Buffer) are shared (treated as immutable). */
export function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as unknown as T;
  if (!isRecord(value)) return value;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Row = {};
  for (const key of Object.keys(value)) out[key] = deepCopy(value[key]);
  return out as T;
}

/** Length of a string or list; `undefined` for anything else. */
export function lengthOf(value: unknown): number | undefined {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  return undefined;
}
