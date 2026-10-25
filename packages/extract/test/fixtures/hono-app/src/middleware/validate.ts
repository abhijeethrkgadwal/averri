import type { MiddlewareHandler } from "hono";
import type { ZodType } from "zod";

export function validate(schema: ZodType): MiddlewareHandler {
  return async (c, next) => {
    schema.parse(await c.req.json());
    await next();
  };
}
