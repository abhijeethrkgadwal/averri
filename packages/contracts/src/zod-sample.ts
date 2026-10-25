/**
 * Schema-guided input values for the test harness (D-40). Generated tests draw inputs from static
 * arbitraries that testgen infers from field names and Prisma facts; when such a candidate fails the
 * declared Zod schema, the harness conforms it: fields the schema accepts are kept, optional fields
 * it rejects are dropped, and required ones are re-sampled from the schema itself (Zod 4 `_zod.def`
 * introspection; a transform is sampled on its input side). The result is always re-checked with
 * `safeParse`; anything the sampler cannot satisfy (refinements, custom schemas) yields `null`.
 */

type Def = { type: string; [k: string]: unknown };
type ZodLike = { _zod: { def: Def }; safeParse(v: unknown): { success: boolean } };

export interface SampleOptions {
  /** A string matching `re` (fast-check's `stringMatching` when available), or null. */
  stringMatching?: ((re: RegExp) => string | null) | null;
}

export type Sampled = { ok: true; value: unknown } | { ok: false };

const NO: Sampled = { ok: false };

function isZod(v: unknown): v is ZodLike {
  return typeof v === "object" && v !== null && "_zod" in v && typeof (v as { safeParse?: unknown }).safeParse === "function";
}

function defOf(schema: ZodLike): Def {
  return schema._zod.def;
}

interface CheckDef {
  check: string;
  [k: string]: unknown;
}

function checksOf(def: Def): CheckDef[] {
  const checks = Array.isArray(def.checks) ? (def.checks as Array<{ _zod?: { def?: CheckDef } }>) : [];
  return checks.map((c) => c._zod?.def).filter((d): d is CheckDef => d !== undefined);
}

function stringCandidate(def: Def, attempt: number, opts: SampleOptions): string | null {
  let min = 0;
  let max = Infinity;
  // Top-level formats (`z.email()`, `z.uuid()`) carry the format on the schema's own def.
  let format: string | null = typeof def.format === "string" ? def.format : null;
  let pattern: RegExp | null = def.pattern instanceof RegExp ? def.pattern : null;
  let prefix = "";
  let suffix = "";
  let includes = "";
  let lower = false;
  let upper = false;
  for (const c of checksOf(def)) {
    if (c.check === "min_length") min = Math.max(min, Number(c.minimum));
    else if (c.check === "max_length") max = Math.min(max, Number(c.maximum));
    else if (c.check === "length_equals") {
      min = Number(c.length);
      max = Number(c.length);
    } else if (c.check === "string_format") {
      const f = String(c.format);
      if (f === "starts_with") prefix = String(c.prefix ?? "");
      else if (f === "ends_with") suffix = String(c.suffix ?? "");
      else if (f === "includes") includes = String(c.includes ?? "");
      else if (f === "lowercase") lower = true;
      else if (f === "uppercase") upper = true;
      else {
        format = f;
        if (c.pattern instanceof RegExp) pattern = c.pattern;
      }
    }
  }
  const n = attempt + 1;
  let base: string | null;
  switch (format) {
    case "email":
      base = `user${n}.${Date.now().toString(36)}@example.test`;
      break;
    case "uuid":
    case "guid":
      base = globalThis.crypto.randomUUID();
      break;
    case "url":
      base = `https://example.test/${n}`;
      break;
    case "datetime":
      base = new Date(Date.UTC(2026, 0, 1 + attempt)).toISOString();
      break;
    case "date":
      base = `2026-01-${String(1 + (attempt % 28)).padStart(2, "0")}`;
      break;
    case "time":
      base = "12:00:00";
      break;
    case null:
      base = `v${n}${Math.random().toString(36).slice(2, 8)}`;
      break;
    default:
      base = pattern !== null && opts.stringMatching ? opts.stringMatching(pattern) : null;
  }
  if (base === null) return null;
  if (format === null) {
    base = `${prefix}${includes}${base}${suffix}`;
    if (upper) base = base.toUpperCase();
    if (lower) base = base.toLowerCase();
    while (base.length < min) base += upper ? "X" : "x";
    if (base.length > max) base = base.slice(0, max);
  }
  return base;
}

function numberCandidate(def: Def, attempt: number): number | bigint {
  let lo = -Infinity;
  let hi = Infinity;
  let loInc = true;
  let hiInc = true;
  let int = def.type === "bigint";
  let step: number | null = null;
  for (const c of checksOf(def)) {
    if (c.check === "greater_than") {
      lo = Number(c.value);
      loInc = c.inclusive === true;
    } else if (c.check === "less_than") {
      hi = Number(c.value);
      hiInc = c.inclusive === true;
    } else if (c.check === "number_format") {
      if (String(c.format).includes("int")) int = true;
    } else if (c.check === "multiple_of") step = Number(c.value);
  }
  const delta = int ? 1 : 0.5;
  const low = Number.isFinite(lo) ? (loInc ? lo : lo + delta) : null;
  const high = Number.isFinite(hi) ? (hiInc ? hi : hi - delta) : null;
  let v = low !== null ? low + attempt : high !== null ? Math.min(high, 1) - attempt : 1 + attempt;
  if (high !== null && v > high) v = high;
  if (low !== null && v < low) v = low;
  if (step !== null && step > 0) v = Math.ceil(v / step) * step;
  if (int) v = Math.ceil(v);
  return def.type === "bigint" ? BigInt(v) : v;
}

/** A value `schema.safeParse` accepts, or `{ ok: false }`. */
export function sampleSchema(schema: unknown, opts: SampleOptions = {}, attempts = 12): Sampled {
  if (!isZod(schema)) return NO;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const r = sampleOnce(schema, opts, attempt, 0);
    if (r.ok && schema.safeParse(r.value).success) return r;
  }
  return NO;
}

function sampleOnce(schema: ZodLike, opts: SampleOptions, attempt: number, depth: number): Sampled {
  if (depth > 8) return NO;
  const def = defOf(schema);
  const inner = (key: string): Sampled => (isZod(def[key]) ? sampleOnce(def[key] as ZodLike, opts, attempt, depth + 1) : NO);
  switch (def.type) {
    case "string": {
      const s = stringCandidate(def, attempt, opts);
      return s === null ? NO : { ok: true, value: s };
    }
    case "number":
    case "int":
    case "bigint":
      return { ok: true, value: numberCandidate(def, attempt) };
    case "boolean":
      return { ok: true, value: attempt % 2 === 0 };
    case "date":
      return { ok: true, value: new Date(Date.UTC(2026, 0, 1 + attempt)) };
    case "enum": {
      const values = Object.values((def.entries ?? {}) as Record<string, unknown>);
      return values.length === 0 ? NO : { ok: true, value: values[attempt % values.length] };
    }
    case "literal": {
      const values = Array.isArray(def.values) ? def.values : [];
      return values.length === 0 ? NO : { ok: true, value: values[attempt % values.length] };
    }
    case "null":
      return { ok: true, value: null };
    case "undefined":
    case "void":
      return { ok: true, value: undefined };
    case "any":
    case "unknown":
      return { ok: true, value: `v${attempt + 1}` };
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "success":
      return inner("innerType");
    case "pipe":
      return inner("in");
    case "lazy": {
      const getter = def.getter;
      if (typeof getter !== "function") return NO;
      const target = (getter as () => unknown)();
      return isZod(target) ? sampleOnce(target, opts, attempt, depth + 1) : NO;
    }
    case "array": {
      let min = 0;
      for (const c of checksOf(def)) if (c.check === "min_length" || c.check === "length_equals") min = Math.max(min, Number(c.minimum ?? c.length));
      const out: unknown[] = [];
      for (let i = 0; i < min; i++) {
        const el = inner("element");
        if (!el.ok) return NO;
        out.push(el.value);
      }
      return { ok: true, value: out };
    }
    case "tuple": {
      const items = Array.isArray(def.items) ? def.items : [];
      const out: unknown[] = [];
      for (const item of items) {
        if (!isZod(item)) return NO;
        const r = sampleOnce(item, opts, attempt, depth + 1);
        if (!r.ok) return NO;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case "union": {
      const options = Array.isArray(def.options) ? def.options : [];
      for (let i = 0; i < options.length; i++) {
        const option = options[(attempt + i) % options.length];
        if (!isZod(option)) continue;
        const r = sampleOnce(option, opts, attempt, depth + 1);
        if (r.ok && option.safeParse(r.value).success) return r;
      }
      return NO;
    }
    case "record":
      return { ok: true, value: {} };
    case "object": {
      const shape = (typeof def.shape === "object" && def.shape !== null ? def.shape : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        if (!isZod(field)) return NO;
        if (field.safeParse(undefined).success) continue;
        const r = sampleOnce(field, opts, attempt, depth + 1);
        if (!r.ok) return NO;
        out[key] = r.value;
      }
      return { ok: true, value: out };
    }
    default:
      return NO;
  }
}

/** Unwrap optional/default/pipe wrappers to the object schema of an input, if any. */
function objectShape(schema: ZodLike): Record<string, unknown> | null {
  let current: ZodLike = schema;
  for (let i = 0; i < 8; i++) {
    const def = defOf(current);
    if (def.type === "object") return (def.shape ?? {}) as Record<string, unknown>;
    const next = def.type === "pipe" ? def.in : def.innerType;
    if (!isZod(next)) return null;
    current = next;
  }
  return null;
}

/**
 * Make `candidate` acceptable to `schema` while changing as little as possible: keep the fields the
 * schema accepts, drop optional fields it rejects, re-sample required ones. Null when impossible.
 */
export function conformInput(schema: unknown, candidate: unknown, opts: SampleOptions = {}): Record<string, unknown> | null {
  if (!isZod(schema)) return null;
  if (schema.safeParse(candidate).success) return typeof candidate === "object" && candidate !== null ? (candidate as Record<string, unknown>) : null;
  const shape = objectShape(schema);
  if (shape === null) {
    const r = sampleSchema(schema, opts);
    return r.ok && typeof r.value === "object" && r.value !== null ? (r.value as Record<string, unknown>) : null;
  }
  const out: Record<string, unknown> = typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? { ...(candidate as Record<string, unknown>) } : {};
  for (const [key, field] of Object.entries(shape)) {
    if (!isZod(field)) return null;
    if (field.safeParse(out[key]).success) continue;
    if (field.safeParse(undefined).success) {
      delete out[key];
      continue;
    }
    const r = sampleSchema(field, opts);
    if (!r.ok) return null;
    out[key] = r.value;
  }
  return schema.safeParse(out).success ? out : null;
}
