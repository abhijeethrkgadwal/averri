/**
 * Tasks: numbered per project, assignable only to members of the organization, with `completedAt`
 * maintained from the status transition.
 */
import { z } from "zod";
import type { Actor, OrgAccess } from "../auth.js";
import type { AppDeps } from "../context.js";
import type { Db } from "../db.js";
import { eventName } from "../events.js";
import { idSchema, taskPrioritySchema, taskStatusSchema } from "../lib/constants.js";
import { errors } from "../lib/errors.js";
import { PAGE_ORDER, paginate, type PaginationQuery } from "../lib/pagination.js";
import { recordAudit } from "./audit.js";

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  priority: taskPrioritySchema.default("medium"),
  assigneeId: idSchema.nullable().optional(),
  dueAt: z.iso.datetime().transform((v) => new Date(v)).optional(),
});

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    assigneeId: idSchema.nullable().optional(),
    dueAt: z.iso.datetime().transform((v) => new Date(v)).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });

export const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  assigneeId: idSchema.optional(),
  priority: taskPrioritySchema.optional(),
});

export function serializeTask(t: {
  id: string;
  organizationId: string;
  projectId: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  createdById: string;
  dueAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  project?: { key: string };
}) {
  return {
    id: t.id,
    organizationId: t.organizationId,
    projectId: t.projectId,
    number: t.number,
    ...(t.project === undefined ? {} : { ref: `${t.project.key}-${t.number}` }),
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assigneeId: t.assigneeId,
    createdById: t.createdById,
    dueAt: t.dueAt,
    completedAt: t.completedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

async function assertAssignee(db: Db, orgId: string, assigneeId: string | null | undefined): Promise<void> {
  if (assigneeId === null || assigneeId === undefined) return;
  const membership = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId: assigneeId } }, select: { id: true } });
  if (membership === null) throw errors.unprocessable("assignee_not_member", "The assignee must be a member of the organization");
}

async function creatorId(db: Db, actor: Actor): Promise<string> {
  if (actor.type === "user") return actor.id;
  const key = await db.apiKey.findUnique({ where: { id: actor.id }, select: { createdById: true } });
  if (key === null) throw errors.unauthorized();
  return key.createdById;
}

export async function createTask(deps: AppDeps, access: OrgAccess, projectId: string, input: z.output<typeof createTaskSchema>) {
  const actor = access.actor;
  const task = await deps.db.$transaction(async (tx) => {
    const project = await tx.project.findFirst({ where: { id: projectId, organizationId: access.org.id } });
    if (project === null) throw errors.notFound("Project");
    if (project.status !== "active") throw errors.conflict("project_archived", "Tasks cannot be added to an archived project");
    await assertAssignee(tx, access.org.id, input.assigneeId);
    const counter = await tx.project.update({ where: { id: project.id }, data: { taskCounter: { increment: 1 } }, select: { taskCounter: true, key: true } });
    const created = await tx.task.create({
      data: {
        organizationId: access.org.id,
        projectId: project.id,
        number: counter.taskCounter,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        status: "todo",
        assigneeId: input.assigneeId ?? null,
        createdById: await creatorId(tx, actor),
        dueAt: input.dueAt ?? null,
      },
      include: { project: { select: { key: true } } },
    });
    await recordAudit(tx, { organizationId: access.org.id, actor, action: "task.created", targetType: "task", targetId: created.id, metadata: { projectId: project.id, number: created.number } });
    return created;
  });
  await deps.events.send({
    name: eventName("TaskCreated"),
    data: { taskId: task.id, organizationId: task.organizationId, projectId: task.projectId, assigneeId: task.assigneeId, createdBy: actor.id },
  });
  return serializeTask(task);
}

export async function listTasks(deps: AppDeps, orgId: string, projectId: string, query: PaginationQuery, filter: z.output<typeof listTasksQuerySchema>) {
  const project = await deps.db.project.findFirst({ where: { id: projectId, organizationId: orgId }, select: { id: true } });
  if (project === null) throw errors.notFound("Project");
  const page = await paginate(query, ({ take, cursor }) =>
    deps.db.task.findMany({
      where: {
        organizationId: orgId,
        projectId,
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.assigneeId === undefined ? {} : { assigneeId: filter.assigneeId }),
        ...(filter.priority === undefined ? {} : { priority: filter.priority }),
        ...(cursor ?? {}),
      },
      include: { project: { select: { key: true } } },
      orderBy: PAGE_ORDER,
      take,
    }),
  );
  return { data: page.data.map(serializeTask), nextCursor: page.nextCursor };
}

export async function getTask(deps: AppDeps, orgId: string, taskId: string) {
  const task = await deps.db.task.findFirst({ where: { id: taskId, organizationId: orgId }, include: { project: { select: { key: true } } } });
  if (task === null) throw errors.notFound("Task");
  return serializeTask(task);
}

export async function updateTask(deps: AppDeps, access: OrgAccess, taskId: string, input: z.output<typeof updateTaskSchema>) {
  const now = deps.now();
  const task = await deps.db.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({ where: { id: taskId, organizationId: access.org.id }, include: { project: { select: { status: true } } } });
    if (existing === null) throw errors.notFound("Task");
    if (existing.project.status !== "active") throw errors.conflict("project_archived", "Tasks in an archived project are read-only");
    if (input.assigneeId !== undefined) await assertAssignee(tx, access.org.id, input.assigneeId);
    const nextStatus = input.status ?? existing.status;
    const completedAt = nextStatus === "done" ? (existing.status === "done" ? existing.completedAt : now) : null;
    const updated = await tx.task.update({
      where: { id: existing.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        status: nextStatus,
        completedAt,
      },
      include: { project: { select: { key: true } } },
    });
    await recordAudit(tx, {
      organizationId: access.org.id,
      actor: access.actor,
      action: "task.updated",
      targetType: "task",
      targetId: updated.id,
      metadata: { ...input, ...(input.status === undefined ? {} : { from: existing.status }) },
    });
    return updated;
  });
  return serializeTask(task);
}

export async function deleteTask(deps: AppDeps, access: OrgAccess, taskId: string) {
  await deps.db.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({ where: { id: taskId, organizationId: access.org.id } });
    if (existing === null) throw errors.notFound("Task");
    await tx.task.delete({ where: { id: existing.id } });
    await recordAudit(tx, { organizationId: access.org.id, actor: access.actor, action: "task.deleted", targetType: "task", targetId: existing.id });
  });
  return { id: taskId, deleted: true };
}
