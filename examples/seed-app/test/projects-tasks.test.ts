import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers.js";

describe("projects and tasks", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  describe("projects", () => {
    it("an admin creates a project; the key is derived from the name when omitted; ProjectCreated is emitted", async () => {
      const res = await ctx.request("POST", "/orgs/org_acme/projects", { as: "admin", body: { name: "Customer Data Platform" } });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ organizationId: "org_acme", name: "Customer Data Platform", key: "CDP", status: "active", taskCount: 0, createdById: "u_admin", archivedAt: null });
      expect(ctx.events.sent.at(-1)).toMatchObject({ name: "averri/ProjectCreated", data: { projectId: res.body.id, key: "CDP", createdBy: "u_admin" } });
    });

    it("explicit keys are validated and unique per organization (not globally)", async () => {
      expect((await ctx.request("POST", "/orgs/org_acme/projects", { as: "owner", body: { name: "Dup", key: "WEB" } })).status).toBe(409);
      expect((await ctx.request("POST", "/orgs/org_acme/projects", { as: "owner", body: { name: "Bad", key: "web-1" } })).status).toBe(400);
      const other = await ctx.request("POST", "/orgs/org_globex/projects", { as: "otherAdmin", body: { name: "Globex Web", key: "WEB" } });
      expect(other.status).toBe(201);
    });

    it("members can read projects but not create or edit them; other organizations see nothing", async () => {
      expect((await ctx.request("POST", "/orgs/org_acme/projects", { as: "member", body: { name: "Nope" } })).status).toBe(403);
      expect((await ctx.request("PATCH", "/orgs/org_acme/projects/proj_website", { as: "member", body: { name: "Nope" } })).status).toBe(403);
      const list = await ctx.request("GET", "/orgs/org_acme/projects", { as: "member" });
      expect(list.status).toBe(200);
      expect(list.body.data.map((p: { key: string }) => p.key).sort()).toEqual(["CDP", "MOB", "WEB"]);
      expect(list.body.data.find((p: { key: string }) => p.key === "WEB").taskCount).toBe(3);
      expect((await ctx.request("GET", "/orgs/org_acme/projects/proj_website", { as: "otherAdmin" })).status).toBe(403);
      expect((await ctx.request("GET", "/orgs/org_globex/projects/proj_website", { as: "otherAdmin" })).status).toBe(404);
    });

    it("paginates and filters by status", async () => {
      const page1 = await ctx.request("GET", "/orgs/org_acme/projects?limit=2", { as: "member" });
      expect(page1.body.data).toHaveLength(2);
      const page2 = await ctx.request("GET", `/orgs/org_acme/projects?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { as: "member" });
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();
      expect((await ctx.request("GET", "/orgs/org_acme/projects?status=archived", { as: "member" })).body.data).toEqual([]);
    });

    it("update, archive, and archived projects are read-only", async () => {
      const upd = await ctx.request("PATCH", "/orgs/org_acme/projects/proj_mobile", { as: "admin", body: { description: "iOS first" } });
      expect(upd.status).toBe(200);
      expect(upd.body.description).toBe("iOS first");
      expect((await ctx.request("PATCH", "/orgs/org_acme/projects/proj_mobile", { as: "admin", body: {} })).status).toBe(400);

      const archived = await ctx.request("POST", "/orgs/org_acme/projects/proj_mobile/archive", { as: "owner" });
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ status: "archived", archivedAt: ctx.clock.now.toISOString() });
      expect((await ctx.request("POST", "/orgs/org_acme/projects/proj_mobile/archive", { as: "owner" })).status).toBe(409);
      expect((await ctx.request("PATCH", "/orgs/org_acme/projects/proj_mobile", { as: "admin", body: { name: "X" } })).status).toBe(409);
      const task = await ctx.request("POST", "/orgs/org_acme/projects/proj_mobile/tasks", { as: "member", body: { title: "Nope" } });
      expect(task.status).toBe(409);
      expect(task.body.error.code).toBe("project_archived");
      expect((await ctx.request("GET", "/orgs/org_acme/projects?status=archived", { as: "member" })).body.data.map((p: { id: string }) => p.id)).toEqual(["proj_mobile"]);
    });
  });

  describe("tasks", () => {
    it("a member creates a task: next number in the project, todo, TaskCreated emitted", async () => {
      const res = await ctx.request("POST", "/orgs/org_acme/projects/proj_website/tasks", {
        as: "member",
        body: { title: "Ship it", priority: "high", assigneeId: "u_admin", dueAt: "2026-11-01T00:00:00.000Z" },
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ projectId: "proj_website", number: 4, ref: "WEB-4", status: "todo", priority: "high", assigneeId: "u_admin", createdById: "u_member", completedAt: null, dueAt: "2026-11-01T00:00:00.000Z" });
      expect(ctx.events.sent.at(-1)).toMatchObject({ name: "averri/TaskCreated", data: { taskId: res.body.id, assigneeId: "u_admin" } });
      const next = await ctx.request("POST", "/orgs/org_acme/projects/proj_website/tasks", { as: "owner", body: { title: "Second" } });
      expect(next.body.number).toBe(5);
      expect(next.body.priority).toBe("medium");
    });

    it("API keys can create tasks (attributed to the key creator)", async () => {
      const res = await ctx.request("POST", "/orgs/org_acme/projects/proj_website/tasks", { as: { token: ctx.seed.apiKeys.acmeMember.secret }, body: { title: "From CI" } });
      expect(res.status).toBe(201);
      expect(res.body.createdById).toBe("u_owner");
    });

    it("validates: unknown project 404, assignee must be a member (422), bad dates 400, cross-tenant 404", async () => {
      expect((await ctx.request("POST", "/orgs/org_acme/projects/proj_ghost/tasks", { as: "member", body: { title: "x" } })).status).toBe(404);
      const assignee = await ctx.request("POST", "/orgs/org_acme/projects/proj_website/tasks", { as: "member", body: { title: "x", assigneeId: "u_other" } });
      expect(assignee.status).toBe(422);
      expect(assignee.body.error.code).toBe("assignee_not_member");
      expect((await ctx.request("POST", "/orgs/org_acme/projects/proj_website/tasks", { as: "member", body: { title: "x", dueAt: "tomorrow" } })).status).toBe(400);
      expect((await ctx.request("POST", "/orgs/org_globex/projects/proj_website/tasks", { as: "otherAdmin", body: { title: "x" } })).status).toBe(404);
      expect((await ctx.request("GET", "/orgs/org_globex/tasks/task_web_1", { as: "otherAdmin" })).status).toBe(404);
    });

    it("lists tasks with filters and pagination", async () => {
      const all = await ctx.request("GET", "/orgs/org_acme/projects/proj_website/tasks", { as: "member" });
      expect(all.status).toBe(200);
      expect(all.body.data).toHaveLength(6);
      const done = await ctx.request("GET", "/orgs/org_acme/projects/proj_website/tasks?status=done", { as: "member" });
      expect(done.body.data.map((t: { id: string }) => t.id)).toEqual(["task_web_1"]);
      const mine = await ctx.request("GET", "/orgs/org_acme/projects/proj_website/tasks?assigneeId=u_admin", { as: "member" });
      expect(mine.body.data).toHaveLength(2);
      const page = await ctx.request("GET", "/orgs/org_acme/projects/proj_website/tasks?limit=4", { as: "member" });
      expect(page.body.data).toHaveLength(4);
      const rest = await ctx.request("GET", `/orgs/org_acme/projects/proj_website/tasks?limit=4&cursor=${encodeURIComponent(page.body.nextCursor)}`, { as: "member" });
      expect(rest.body.data).toHaveLength(2);
      expect(rest.body.nextCursor).toBeNull();
      expect((await ctx.request("GET", "/orgs/org_acme/projects/proj_website/tasks?status=bogus", { as: "member" })).status).toBe(400);
    });

    it("status transitions maintain completedAt; done → todo clears it", async () => {
      const done = await ctx.request("PATCH", "/orgs/org_acme/tasks/task_web_3", { as: "member", body: { status: "done" } });
      expect(done.status).toBe(200);
      expect(done.body.completedAt).toBe(ctx.clock.now.toISOString());
      ctx.clock.advance(5000);
      const stillDone = await ctx.request("PATCH", "/orgs/org_acme/tasks/task_web_3", { as: "member", body: { title: "Set up analytics (GA4)" } });
      expect(stillDone.body.completedAt).toBe(done.body.completedAt);
      const reopened = await ctx.request("PATCH", "/orgs/org_acme/tasks/task_web_3", { as: "member", body: { status: "in_progress" } });
      expect(reopened.body.completedAt).toBeNull();
      const audit = await ctx.db.auditLog.findMany({ where: { targetId: "task_web_3", action: "task.updated" } });
      expect(audit).toHaveLength(3);
      expect((await ctx.request("PATCH", "/orgs/org_acme/tasks/task_web_3", { as: "member", body: { bogus: 1 } })).status).toBe(400);
    });

    it("GET a single task includes the project ref; DELETE needs admin and is tenant-scoped", async () => {
      const get = await ctx.request("GET", "/orgs/org_acme/tasks/task_web_1", { as: "member" });
      expect(get.status).toBe(200);
      expect(get.body.ref).toBe("WEB-1");
      expect((await ctx.request("DELETE", "/orgs/org_acme/tasks/task_web_1", { as: "member" })).status).toBe(403);
      expect((await ctx.request("DELETE", "/orgs/org_globex/tasks/task_web_1", { as: "otherAdmin" })).status).toBe(404);
      const del = await ctx.request("DELETE", "/orgs/org_acme/tasks/task_web_1", { as: "admin" });
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ id: "task_web_1", deleted: true });
      expect((await ctx.request("GET", "/orgs/org_acme/tasks/task_web_1", { as: "member" })).status).toBe(404);
    });
  });
});
