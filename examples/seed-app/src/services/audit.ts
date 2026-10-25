/**
 * Audit log: append-only records of who did what inside an organization. Services call `recordAudit`
 * inside their transaction so the entry commits with the change it describes.
 */
import type { Actor } from "../auth.js";
import type { Db } from "../db.js";
import type { AuditActorType } from "../lib/constants.js";
import { PAGE_ORDER, paginate, type PaginationQuery } from "../lib/pagination.js";

export interface AuditEntry {
  organizationId: string;
  actor: Actor | { type: "webhook" | "system"; id?: string } | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

function actorTypeOf(actor: AuditEntry["actor"]): AuditActorType {
  if (actor === null) return "system";
  return actor.type;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      actorType: actorTypeOf(entry.actor),
      actorId: entry.actor?.id ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
    },
  });
}

export function serializeAudit(row: {
  id: string;
  organizationId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    actor: { type: row.actorType, id: row.actorId },
    action: row.action,
    target: { type: row.targetType, id: row.targetId },
    metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as Record<string, unknown>),
    createdAt: row.createdAt,
  };
}

export async function listAudit(db: Db, organizationId: string, query: PaginationQuery, filter: { action?: string; targetType?: string }) {
  const page = await paginate(query, ({ take, cursor }) =>
    db.auditLog.findMany({
      where: {
        organizationId,
        ...(filter.action === undefined ? {} : { action: filter.action }),
        ...(filter.targetType === undefined ? {} : { targetType: filter.targetType }),
        ...(cursor === undefined ? {} : cursor),
      },
      orderBy: PAGE_ORDER,
      take,
    }),
  );
  return { data: page.data.map(serializeAudit), nextCursor: page.nextCursor };
}
