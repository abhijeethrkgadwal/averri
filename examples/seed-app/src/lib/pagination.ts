/**
 * Keyset ("cursor") pagination shared by every list endpoint.
 *
 * Rows are ordered newest first by `(createdAt desc, id desc)`; the cursor is the opaque base64url
 * encoding of the last row's `(createdAt, id)`. Clients pass `?limit=&cursor=` and receive
 * `{ data, nextCursor }` where `nextCursor` is `null` on the last page.
 */
import { z } from "zod";
import { errors } from "./errors.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.output<typeof paginationQuerySchema>;

export interface CursorKey {
  createdAt: Date;
  id: string;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify({ t: key.createdAt.toISOString(), i: key.id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw errors.badRequest("invalid_cursor", "The cursor is not valid");
  }
  const shape = z.object({ t: z.string(), i: z.string().min(1) }).safeParse(parsed);
  if (!shape.success) throw errors.badRequest("invalid_cursor", "The cursor is not valid");
  const createdAt = new Date(shape.data.t);
  if (Number.isNaN(createdAt.getTime())) throw errors.badRequest("invalid_cursor", "The cursor is not valid");
  return { createdAt, id: shape.data.i };
}

/** True when `cursor` decodes to a cursor this API issued (the Averri query declarations validate with it). */
export function isValidCursor(cursor: string): boolean {
  try {
    decodeCursor(cursor);
    return true;
  } catch {
    return false;
  }
}

/** `orderBy` matching the cursor semantics; pass to Prisma as-is. */
export const PAGE_ORDER = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * Prisma `where` fragment selecting rows strictly after the cursor in `PAGE_ORDER`. Combine with the
 * endpoint's own filter via `AND`.
 */
export function cursorWhere(cursor: string | undefined): { OR: Array<Record<string, unknown>> } | undefined {
  if (cursor === undefined) return undefined;
  const key = decodeCursor(cursor);
  return {
    OR: [{ createdAt: { lt: key.createdAt } }, { createdAt: key.createdAt, id: { lt: key.id } }],
  };
}

/** Fetch `limit + 1` rows with `fetch`, then trim and compute the next cursor. */
export async function paginate<T extends CursorKey>(
  query: PaginationQuery,
  fetch: (args: { take: number; cursor: ReturnType<typeof cursorWhere> }) => Promise<T[]>,
): Promise<Page<T>> {
  const rows = await fetch({ take: query.limit + 1, cursor: cursorWhere(query.cursor) });
  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  const last = data[data.length - 1];
  return { data, nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null };
}
