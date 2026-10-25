/**
 * The tier-3 guard runner (SPEC-CONTRACTS §6): calls the bare async function with the typed context
 * and the PLAIN (non-transactional) client, measures duration, and fails closed — a throw, a rejection
 * or any return value other than `true` is a failed guard.
 */
import type { Actor, AnyGuardFn, GuardContext } from "@averri/core";
import { errorMessage } from "./errors.js";
import type { PrismaLike, Row } from "./types.js";

export interface GuardRunInput {
  input: unknown;
  actor: Actor | null;
  self: Row | null;
  old: Row | null;
  result: unknown;
  /** The plain Prisma client (never the transaction client). */
  prisma: PrismaLike | null | undefined;
}

export interface GuardRunResult {
  ok: boolean;
  durationMs: number;
  /** Set when the guard threw/rejected or returned a non-boolean. */
  error?: string;
}

export function guardContext(input: GuardRunInput): GuardContext<unknown, unknown, Actor | null> {
  return {
    input: input.input,
    actor: input.actor,
    self: input.self,
    old: input.old,
    result: input.result,
    prisma: (input.prisma ?? {}) as GuardContext["prisma"],
  };
}

export async function runGuard(guard: AnyGuardFn, input: GuardRunInput): Promise<GuardRunResult> {
  const started = performance.now();
  try {
    const verdict = await (guard as unknown as (ctx: GuardContext<unknown, unknown, Actor | null>) => boolean | Promise<boolean>)(guardContext(input));
    const durationMs = elapsed(started);
    if (verdict === true) return { ok: true, durationMs };
    if (verdict === false) return { ok: false, durationMs };
    return { ok: false, durationMs, error: `guard returned ${typeof verdict} instead of a boolean` };
  } catch (error) {
    return { ok: false, durationMs: elapsed(started), error: `guard threw: ${errorMessage(error)}` };
  }
}

export function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
}
