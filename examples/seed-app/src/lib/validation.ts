/**
 * Zod helpers for Hono handlers. All three parsers throw a 400 `validation_failed` AppError whose
 * `details` is a flat list of `{ path, message }` issues.
 */
import type { Context } from "hono";
import type { z } from "zod";
import { errors } from "./errors.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown, source: "body" | "query" | "params"): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw errors.validation({ source, issues: issuesOf(result.error) });
  }
  return result.data;
}

/** Parse the JSON body. A missing or malformed body is a validation error, not a 500. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const text = await c.req.text();
    if (text.trim().length === 0) {
      raw = {};
    } else {
      throw errors.badRequest("unsupported_media_type", "Expected a JSON body (content-type: application/json)");
    }
  } else {
    try {
      raw = await c.req.json();
    } catch {
      throw errors.badRequest("malformed_json", "Request body is not valid JSON");
    }
  }
  return parseWith(schema, raw, "body");
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parseWith(schema, c.req.query(), "query");
}

export function parseParams<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parseWith(schema, c.req.param(), "params");
}
