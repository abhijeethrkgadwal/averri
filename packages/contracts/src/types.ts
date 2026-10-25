/**
 * Shared runtime types of `@averri/contracts`.
 */
import type { EventId, RefPath } from "@averri/ir";

/** A loaded row (subject, element of an owned list, result object). */
export type Row = Record<string, unknown>;

/**
 * The values the five reference roots resolve against (SPEC-CONTRACTS §2). Absent roots resolve every
 * ref to `undefined` (comparisons false, ref listed in `undefinedRefs`). `emitted` is the list of event
 * ids buffered by this invocation (one entry per emission) for `e.emitted`.
 */
export interface EvalEnv {
  input?: unknown;
  actor?: unknown;
  self?: Row | null;
  old?: Row | null;
  result?: unknown;
  emitted?: readonly EventId[];
}

/** One entry of `PhaseRecord.evaluated`, keyed by the AST path of the comparison node. */
export interface EvaluatedEntry {
  lhs: unknown;
  rhs: unknown;
}

export interface EvalResult {
  ok: boolean;
  /** `""` for a root comparison, `args[1]` for the second conjunct, `arg.args[0]` under a `not`, ... */
  evaluated: Record<string, EvaluatedEntry>;
  /** Refs that resolved to `undefined` (fail-closed rule). Deduplicated, in first-seen order. */
  undefinedRefs: RefPath[];
}

/** Result of one `db.*` node against the database (or its fail-closed short-circuit). */
export interface DbResult {
  /** The row count, or `null` when the Prisma call was skipped (undefined ref). */
  count: number | null;
  undefinedRefs: RefPath[];
  /** The Prisma `where` that was (or would have been) sent. */
  where: Record<string, unknown>;
  /** True when no Prisma call was made because a ref was undefined. */
  skipped: boolean;
}

/**
 * The project's Prisma client, seen structurally. `@averri/contracts` only uses
 * `prisma[<clientName>].count/findMany/findFirst` and `prisma.$transaction(fn, opts)`; the type is
 * `object` so real `PrismaClient` instances, transaction clients and the test fakes are all accepted.
 */
export type PrismaLike = object;

/** What a model accessor (`prisma.invitation`) must offer. */
export interface PrismaModelLike {
  count(args?: { where?: unknown }): Promise<number>;
  findMany(args?: { where?: unknown; take?: number; include?: unknown; orderBy?: unknown }): Promise<Row[]>;
  findFirst?(args?: { where?: unknown; include?: unknown }): Promise<Row | null>;
}

export type TransactionFn = <T>(fn: (tx: PrismaLike) => Promise<T>, options?: { maxWait?: number; timeout?: number }) => Promise<T>;
