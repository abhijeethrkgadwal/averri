/**
 * Application errors. Every error that reaches the client is an `AppError`; anything else is a 500.
 * The JSON body is always `{ error: { code, message, details? } }` (see `app.ts` `onError`).
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): { error: { code: string; message: string; details?: unknown } } {
    const body: { error: { code: string; message: string; details?: unknown } } = {
      error: { code: this.code, message: this.message },
    };
    if (this.details !== undefined) body.error.details = this.details;
    return body;
  }
}

export const errors = {
  badRequest: (code: string, message: string, details?: unknown) => new AppError(400, code, message, details),
  validation: (details: unknown) => new AppError(400, "validation_failed", "Request validation failed", details),
  unauthorized: (message = "Authentication required") => new AppError(401, "unauthenticated", message),
  forbidden: (code = "forbidden", message = "You are not allowed to perform this action") => new AppError(403, code, message),
  notFound: (resource: string) => new AppError(404, "not_found", `${resource} not found`),
  conflict: (code: string, message: string, details?: unknown) => new AppError(409, code, message, details),
  gone: (code: string, message: string) => new AppError(410, code, message),
  unprocessable: (code: string, message: string, details?: unknown) => new AppError(422, code, message, details),
  internal: (message = "Internal server error") => new AppError(500, "internal_error", message),
};

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Prisma unique-constraint violation (`P2002`) without importing the Prisma error classes everywhere. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}
