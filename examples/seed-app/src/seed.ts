/**
 * Deterministic seed data shared by `npm run db:seed` and the test suite.
 *
 * Ids and bearer tokens are FIXED so that `averri.config.ts` actor fixtures (`Bearer usr_seed_owner`, ...)
 * resolve against a freshly seeded database, in development and under Vitest alike.
 * Every seeded user's password is `password123`.
 */
import type { AppDeps } from "./context.js";
import type { Db } from "./db.js";
import { hashPassword, sha256 } from "./lib/crypto.js";

export const SEED_PASSWORD = "password123";

export const SEED = {
  users: {
    owner: { id: "u_owner", email: "owner@acme.test", name: "Olivia Owner", token: "usr_seed_owner" },
    admin: { id: "u_admin", email: "admin@acme.test", name: "Adam Admin", token: "usr_seed_admin" },
    member: { id: "u_member", email: "member@acme.test", name: "Mia Member", token: "usr_seed_member" },
    otherAdmin: { id: "u_other", email: "other@globex.test", name: "Omar Other", token: "usr_seed_other" },
    outsider: { id: "u_outsider", email: "outsider@example.test", name: "Oscar Outsider", token: "usr_seed_outsider" },
  },
  orgs: {
    acme: { id: "org_acme", slug: "acme", name: "Acme Inc" },
    globex: { id: "org_globex", slug: "globex", name: "Globex Corp" },
  },
  apiKeys: {
    acmeMember: { id: "key_acme_member", name: "CI reporter", role: "member", secret: "sk_seed_acme_member" },
    acmeAdmin: { id: "key_acme_admin", name: "Deploy bot", role: "admin", secret: "sk_seed_acme_admin" },
  },
  projects: {
    website: { id: "proj_website", key: "WEB", name: "Website relaunch" },
    mobile: { id: "proj_mobile", key: "MOB", name: "Mobile app" },
    globexCrm: { id: "proj_globex_crm", key: "CRM", name: "CRM migration" },
  },
  invitations: {
    pending: { id: "inv_pending", email: "pending@acme.test", role: "member", token: "inv_seed_pending_token" },
  },
  billing: {
    acmeCustomerId: "cus_seed_acme",
    acmeSubscriptionId: "sub_seed_acme",
  },
} as const;

export type SeedData = typeof SEED;

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Insert the seed data set. Expects an empty database (use `resetDatabase` first when re-seeding). */
export async function seedDatabase(deps: Pick<AppDeps, "db" | "now">): Promise<SeedData> {
  const db = deps.db;
  const now = deps.now();
  const passwordHash = hashPassword(SEED_PASSWORD);

  for (const user of Object.values(SEED.users)) {
    await db.user.create({ data: { id: user.id, email: user.email, name: user.name, passwordHash } });
    await db.authToken.create({ data: { tokenHash: sha256(user.token), userId: user.id, expiresAt: new Date(now.getTime() + 12 * MONTH_MS) } });
  }

  await db.organization.create({ data: { ...SEED.orgs.acme } });
  await db.organization.create({ data: { ...SEED.orgs.globex } });

  await db.membership.createMany({
    data: [
      { organizationId: SEED.orgs.acme.id, userId: SEED.users.owner.id, role: "owner" },
      { organizationId: SEED.orgs.acme.id, userId: SEED.users.admin.id, role: "admin" },
      { organizationId: SEED.orgs.acme.id, userId: SEED.users.member.id, role: "member" },
      { organizationId: SEED.orgs.globex.id, userId: SEED.users.otherAdmin.id, role: "owner" },
    ],
  });

  await db.subscription.create({
    data: {
      organizationId: SEED.orgs.acme.id,
      plan: "pro",
      status: "active",
      seats: 5,
      stripeCustomerId: SEED.billing.acmeCustomerId,
      stripeSubscriptionId: SEED.billing.acmeSubscriptionId,
      currentPeriodEnd: new Date(now.getTime() + MONTH_MS),
    },
  });
  await db.subscription.create({ data: { organizationId: SEED.orgs.globex.id, plan: "free", status: "active", seats: 1 } });

  for (const key of [SEED.apiKeys.acmeMember, SEED.apiKeys.acmeAdmin]) {
    await db.apiKey.create({
      data: {
        id: key.id,
        organizationId: SEED.orgs.acme.id,
        name: key.name,
        role: key.role,
        prefix: key.secret.slice(0, 11),
        secretHash: sha256(key.secret),
        createdById: SEED.users.owner.id,
      },
    });
  }

  await db.project.create({
    data: { ...SEED.projects.website, organizationId: SEED.orgs.acme.id, createdById: SEED.users.owner.id, description: "New marketing site", taskCounter: 3 },
  });
  await db.project.create({ data: { ...SEED.projects.mobile, organizationId: SEED.orgs.acme.id, createdById: SEED.users.admin.id, taskCounter: 0 } });
  await db.project.create({ data: { ...SEED.projects.globexCrm, organizationId: SEED.orgs.globex.id, createdById: SEED.users.otherAdmin.id, taskCounter: 1 } });

  await db.task.createMany({
    data: [
      { id: "task_web_1", organizationId: SEED.orgs.acme.id, projectId: SEED.projects.website.id, number: 1, title: "Design homepage", status: "done", priority: "high", assigneeId: SEED.users.member.id, createdById: SEED.users.owner.id, completedAt: now },
      { id: "task_web_2", organizationId: SEED.orgs.acme.id, projectId: SEED.projects.website.id, number: 2, title: "Write copy", status: "in_progress", priority: "medium", assigneeId: SEED.users.admin.id, createdById: SEED.users.owner.id },
      { id: "task_web_3", organizationId: SEED.orgs.acme.id, projectId: SEED.projects.website.id, number: 3, title: "Set up analytics", status: "todo", priority: "low", createdById: SEED.users.member.id },
      { id: "task_crm_1", organizationId: SEED.orgs.globex.id, projectId: SEED.projects.globexCrm.id, number: 1, title: "Export contacts", status: "todo", priority: "medium", createdById: SEED.users.otherAdmin.id },
    ],
  });

  await db.invitation.create({
    data: {
      id: SEED.invitations.pending.id,
      organizationId: SEED.orgs.acme.id,
      email: SEED.invitations.pending.email,
      role: SEED.invitations.pending.role,
      token: SEED.invitations.pending.token,
      invitedById: SEED.users.admin.id,
      status: "pending",
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  await db.auditLog.create({
    data: { organizationId: SEED.orgs.acme.id, actorType: "system", action: "seed.loaded", targetType: "organization", targetId: SEED.orgs.acme.id },
  });

  return SEED;
}

/** Delete every row (child tables first) so the seed can be re-applied. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.auditLog.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.task.deleteMany();
  await db.project.deleteMany();
  await db.apiKey.deleteMany();
  await db.invitation.deleteMany();
  await db.subscription.deleteMany();
  await db.membership.deleteMany();
  await db.authToken.deleteMany();
  await db.organization.deleteMany();
  await db.user.deleteMany();
}
