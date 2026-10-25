/**
 * Projects: organization-scoped containers for tasks with a short unique key (`ACME-12` style numbering).
 */
import { z } from "zod";
import type { Actor, OrgAccess } from "../auth.js";
import type { AppDeps } from "../context.js";
import type { Db } from "../db.js";
import { eventName } from "../events.js";
import { projectKeySchema, projectStatusSchema } from "../lib/constants.js";
import { errors, isUniqueViolation } from "../lib/errors.js";
import { PAGE_ORDER, paginate, type PaginationQuery } from "../lib/pagination.js";
import { recordAudit } from "./audit.js";

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  key: projectKeySchema.optional(),
  description: z.string().trim().max(2000).optional(),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });

export const listProjectsQuerySchema = z.object({ status: projectStatusSchema.optional() });

export function serializeProject(p: {
  id: string;
  organizationId: string;
  name: string;
  key: string;
  description: string | null;
  status: string;
  createdById: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { tasks: number };
}) {
  return {
    id: p.id,
    organizationId: p.organizationId,
    name: p.name,
    key: p.key,
    description: p.description,
    status: p.status,
    createdById: p.createdById,
    archivedAt: p.archivedAt,
    ...(p._count === undefined ? {} : { taskCount: p._count.tasks }),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Derive a key from the name: initials of up to 4 words, else the first letters, upper-cased. */
export function deriveProjectKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  let key = words.length >= 2 ? words.slice(0, 4).map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 4);
  if (!/^[A-Z]/.test(key)) key = `P${key}`;
  return key.slice(0, 8).padEnd(2, "X");
}

export async function createProject(deps: AppDeps, access: OrgAccess, input: z.output<typeof createProjectSchema>) {
  const actor = access.actor;
  const creatorId = actor.type === "user" ? actor.id : await apiKeyCreatorId(deps.db, actor);
  const key = input.key ?? deriveProjectKey(input.name);
  let project;
  try {
    project = await deps.db.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: { organizationId: access.org.id, name: input.name, key, description: input.description ?? null, createdById: creatorId, status: "active" },
        include: { _count: { select: { tasks: true } } },
      });
      await recordAudit(tx, { organizationId: access.org.id, actor, action: "project.created", targetType: "project", targetId: created.id, metadata: { key } });
      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw errors.conflict("key_taken", `A project with key ${key} already exists in this organization`);
    throw error;
  }
  await deps.events.send({ name: eventName("ProjectCreated"), data: { projectId: project.id, organizationId: project.organizationId, key: project.key, createdBy: actor.id } });
  return serializeProject(project);
}

/** API keys act on behalf of the person who created them for rows that require a user foreign key. */
async function apiKeyCreatorId(db: Db, actor: Extract<Actor, { type: "apiKey" }>): Promise<string> {
  const key = await db.apiKey.findUnique({ where: { id: actor.id }, select: { createdById: true } });
  if (key === null) throw errors.unauthorized();
  return key.createdById;
}

export async function listProjects(deps: AppDeps, orgId: string, query: PaginationQuery, filter: { status?: string }) {
  const page = await paginate(query, ({ take, cursor }) =>
    deps.db.project.findMany({
      where: { organizationId: orgId, ...(filter.status === undefined ? {} : { status: filter.status }), ...(cursor ?? {}) },
      include: { _count: { select: { tasks: true } } },
      orderBy: PAGE_ORDER,
      take,
    }),
  );
  return { data: page.data.map(serializeProject), nextCursor: page.nextCursor };
}

export async function getProject(deps: AppDeps, orgId: string, projectId: string) {
  const project = await deps.db.project.findFirst({ where: { id: projectId, organizationId: orgId }, include: { _count: { select: { tasks: true } } } });
  if (project === null) throw errors.notFound("Project");
  return serializeProject(project);
}

export async function updateProject(deps: AppDeps, access: OrgAccess, projectId: string, input: z.output<typeof updateProjectSchema>) {
  const project = await deps.db.$transaction(async (tx) => {
    const existing = await tx.project.findFirst({ where: { id: projectId, organizationId: access.org.id } });
    if (existing === null) throw errors.notFound("Project");
    if (existing.status === "archived") throw errors.conflict("project_archived", "Archived projects are read-only");
    const updated = await tx.project.update({
      where: { id: existing.id },
      data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.description === undefined ? {} : { description: input.description }) },
      include: { _count: { select: { tasks: true } } },
    });
    await recordAudit(tx, { organizationId: access.org.id, actor: access.actor, action: "project.updated", targetType: "project", targetId: updated.id, metadata: input });
    return updated;
  });
  return serializeProject(project);
}

export async function archiveProject(deps: AppDeps, access: OrgAccess, projectId: string) {
  const now = deps.now();
  const project = await deps.db.$transaction(async (tx) => {
    const existing = await tx.project.findFirst({ where: { id: projectId, organizationId: access.org.id } });
    if (existing === null) throw errors.notFound("Project");
    if (existing.status === "archived") throw errors.conflict("project_archived", "Project is already archived");
    const updated = await tx.project.update({ where: { id: existing.id }, data: { status: "archived", archivedAt: now }, include: { _count: { select: { tasks: true } } } });
    await recordAudit(tx, { organizationId: access.org.id, actor: access.actor, action: "project.archived", targetType: "project", targetId: updated.id });
    return updated;
  });
  return serializeProject(project);
}
