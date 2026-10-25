/**
 * Runtime errors raised by `@averri/contracts` for misconfiguration (unknown model accessor, missing
 * Prisma client, missing `$transaction`). Contract VIOLATIONS are never thrown: they become
 * `HandleResult`s and `PhaseRecord`s. Evaluation errors inside a clause (a throwing guard, a Prisma
 * failure in a predicate) are recorded as a failed phase (fail closed), not propagated.
 */
export type AverriRuntimeErrorCode = "no-prisma" | "unknown-model" | "no-transaction" | "bad-declaration" | "bad-config" | "db-op-in-sync-eval" | "unknown-fixture";

export class AverriRuntimeError extends Error {
  override readonly name = "AverriRuntimeError";
  readonly code: AverriRuntimeErrorCode;

  constructor(code: AverriRuntimeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
