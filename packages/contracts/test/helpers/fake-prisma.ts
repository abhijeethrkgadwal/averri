/**
 * A tiny in-memory fake of the Prisma client, shaped like the real one for the subset
 * `@averri/contracts` touches: `prisma.<model>.count/findMany/findFirst/create/update/upsert/delete`
 * and `prisma.$transaction(fn, opts)` (snapshot + restore on throw). Every call is logged.
 */
import type { Row } from "../../src/index.js";

export interface FakeCall {
  model: string;
  op: string;
  args: unknown;
  /** True when issued through the transaction client. */
  tx: boolean;
}

export interface FakeModel {
  count(args?: { where?: unknown }): Promise<number>;
  findMany(args?: { where?: unknown; take?: number; include?: unknown }): Promise<Row[]>;
  findFirst(args?: { where?: unknown; include?: unknown }): Promise<Row | null>;
  create(args: { data: Row }): Promise<Row>;
  update(args: { where: unknown; data: Row }): Promise<Row>;
  upsert(args: { where: unknown; create: Row; update: Row }): Promise<Row>;
  delete(args: { where: unknown }): Promise<Row>;
}

export interface FakePrismaOptions {
  /** Make `$transaction` reject before running the callback. */
  transactionError?: Error;
  /** Make `count` throw for these models. */
  failCount?: string[];
}

export type FakePrisma = {
  [model: string]: FakeModel;
} & {
  $transaction<T>(fn: (tx: FakePrisma) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
  $calls: FakeCall[];
  $tables: Record<string, Row[]>;
  $txOptions: Array<{ timeout?: number; maxWait?: number } | undefined>;
  $txCount: number;
  $isTx: boolean;
  $reset(): void;
};

const OPERATORS = new Set(["in", "notIn", "not", "lt", "lte", "gt", "gte", "equals", "contains", "startsWith", "endsWith"]);

function isPlain(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : a;
    const tb = b instanceof Date ? b.getTime() : b;
    return ta === tb;
  }
  return a === b;
}

function num(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  return typeof v === "number" ? v : Number(v);
}

export function matchesWhere(row: Row, where: unknown): boolean {
  if (!isPlain(where)) return true;
  for (const key of Object.keys(where)) {
    const cond = where[key];
    if (cond === undefined) continue; // Prisma ignores undefined filters (the very thing Averri guards against)
    const value = row[key];
    if (isPlain(cond)) {
      const keys = Object.keys(cond);
      if (keys.some((k) => OPERATORS.has(k))) {
        for (const op of keys) {
          const operand = cond[op];
          if (operand === undefined) continue;
          switch (op) {
            case "equals":
              if (!same(value, operand)) return false;
              break;
            case "in":
              if (!Array.isArray(operand) || !operand.some((o) => same(value, o))) return false;
              break;
            case "notIn":
              if (Array.isArray(operand) && operand.some((o) => same(value, o))) return false;
              break;
            case "not":
              if (isPlain(operand)) {
                if (matchesWhere({ [key]: value }, { [key]: operand })) return false;
              } else if (same(value, operand)) return false;
              break;
            case "lt":
              if (!(num(value) < num(operand))) return false;
              break;
            case "lte":
              if (!(num(value) <= num(operand))) return false;
              break;
            case "gt":
              if (!(num(value) > num(operand))) return false;
              break;
            case "gte":
              if (!(num(value) >= num(operand))) return false;
              break;
            default:
              break;
          }
        }
      } else {
        // nested to-one relation filter
        if (!isPlain(value) || !matchesWhere(value, cond)) return false;
      }
    } else if (!same(value, cond)) {
      return false;
    }
  }
  return true;
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  const out: Row = {};
  for (const key of Object.keys(value as Row)) out[key] = clone((value as Row)[key]);
  return out as T;
}

let nextId = 1;

export function createFakePrisma(initial: Record<string, Row[]>, options: FakePrismaOptions = {}): FakePrisma {
  const tables: Record<string, Row[]> = {};
  for (const name of Object.keys(initial)) tables[name] = clone(initial[name] ?? []);
  const calls: FakeCall[] = [];

  function model(name: string, tx: boolean): FakeModel {
    const rows = (): Row[] => (tables[name] ??= []);
    const log = (op: string, args: unknown): void => {
      calls.push({ model: name, op, args, tx });
    };
    return {
      async count(args = {}) {
        log("count", args);
        if (options.failCount?.includes(name)) throw new Error(`count failed for ${name}`);
        return rows().filter((r) => matchesWhere(r, args.where)).length;
      },
      async findMany(args = {}) {
        log("findMany", args);
        const found = rows().filter((r) => matchesWhere(r, args.where));
        return clone(args.take !== undefined ? found.slice(0, args.take) : found);
      },
      async findFirst(args = {}) {
        log("findFirst", args);
        const found = rows().find((r) => matchesWhere(r, args.where));
        return found === undefined ? null : clone(found);
      },
      async create(args) {
        log("create", args);
        const row: Row = { id: `${name}_${nextId++}`, ...clone(args.data) };
        rows().push(row);
        return clone(row);
      },
      async update(args) {
        log("update", args);
        const row = rows().find((r) => matchesWhere(r, args.where));
        if (row === undefined) throw new Error(`update: no ${name} row matches`);
        Object.assign(row, clone(args.data));
        return clone(row);
      },
      async upsert(args) {
        log("upsert", args);
        const row = rows().find((r) => matchesWhere(r, args.where));
        if (row !== undefined) {
          Object.assign(row, clone(args.update));
          return clone(row);
        }
        const created: Row = { id: `${name}_${nextId++}`, ...clone(args.create) };
        rows().push(created);
        return clone(created);
      },
      async delete(args) {
        log("delete", args);
        const index = rows().findIndex((r) => matchesWhere(r, args.where));
        if (index < 0) throw new Error(`delete: no ${name} row matches`);
        const [removed] = rows().splice(index, 1);
        return clone(removed as Row);
      },
    };
  }

  function client(tx: boolean): FakePrisma {
    const base: Record<string, unknown> = {
      $calls: calls,
      $tables: tables,
      $txOptions: [] as unknown[],
      $txCount: 0,
      $isTx: tx,
      $reset() {
        calls.length = 0;
      },
    };
    const self = new Proxy(base, {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return target[prop];
        if (prop === "$transaction") {
          return async <T>(fn: (txClient: FakePrisma) => Promise<T>, txOptions?: { timeout?: number; maxWait?: number }): Promise<T> => {
            (root.$txOptions as unknown[]).push(txOptions);
            root.$txCount += 1;
            if (options.transactionError) throw options.transactionError;
            const snapshot = clone(tables);
            try {
              return await fn(client(true));
            } catch (error) {
              for (const key of Object.keys(tables)) delete tables[key];
              for (const key of Object.keys(snapshot)) tables[key] = snapshot[key] as Row[];
              throw error;
            }
          };
        }
        if (prop.startsWith("$") || prop === "then") return undefined;
        return model(prop, tx);
      },
      has(target, prop) {
        return typeof prop === "string" && (prop in target || prop === "$transaction" || !prop.startsWith("$"));
      },
    }) as unknown as FakePrisma;
    return self;
  }

  const root = client(false);
  return root;
}
