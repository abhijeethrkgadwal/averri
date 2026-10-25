import type { MiddlewareHandler } from "hono";

export function auth(): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}

export function requireUser(): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}

export function requireRole(_role: string): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}

export function publicRoute(): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}
