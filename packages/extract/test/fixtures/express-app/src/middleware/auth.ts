import type { RequestHandler } from "express";

export function auth(): RequestHandler {
  return (_req, _res, next) => next();
}

export function requireRole(_role: string): RequestHandler {
  return (_req, _res, next) => next();
}
