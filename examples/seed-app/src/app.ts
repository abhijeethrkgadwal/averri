/**
 * Builds the Hono application. `createApp(deps)` is pure: it registers middleware, mounts every
 * route module and returns the app plus the live workflow registrations. `src/server.ts` wires the
 * production dependencies; tests build their own (`test/helpers.ts`).
 */
import { Hono } from "hono";
import { ZodError } from "zod";
import { auth } from "./auth.js";
import { configFromEnv, type AppDeps, type AppEnv } from "./context.js";
import { createPrismaClient } from "./db.js";
import { EventBus, events as defaultEvents } from "./events.js";
import { AppError } from "./lib/errors.js";
import { ConsoleMailer } from "./lib/mailer.js";
import { stripe as defaultStripe } from "./lib/stripe.js";
import { issuesOf } from "./lib/validation.js";
import { apiKeyRoutes } from "./routes/apiKeys.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { healthRoutes } from "./routes/health.js";
import { invitationRoutes } from "./routes/invitations.js";
import { memberRoutes } from "./routes/members.js";
import { organizationRoutes } from "./routes/organizations.js";
import { projectRoutes } from "./routes/projects.js";
import { taskRoutes } from "./routes/tasks.js";
import { registerWorkflows, type Workflows } from "./workflows/index.js";

export type App = Hono<AppEnv>;

export interface CreatedApp {
  app: App;
  deps: AppDeps;
  workflows: Workflows;
}

/** Fill in production defaults for whatever the caller did not inject. */
export function resolveDeps(partial: Partial<AppDeps> = {}): AppDeps {
  return {
    db: partial.db ?? createPrismaClient(),
    events: partial.events ?? (defaultEvents as EventBus),
    mailer: partial.mailer ?? new ConsoleMailer(),
    stripe: partial.stripe ?? defaultStripe,
    config: partial.config ?? configFromEnv(),
    now: partial.now ?? (() => new Date()),
  };
}

export function createApp(partial: Partial<AppDeps> = {}): CreatedApp {
  const deps = resolveDeps(partial);
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("actor", null);
    await next();
  });
  app.use("*", auth);

  app.route("/", healthRoutes);
  app.route("/", authRoutes);
  app.route("/", organizationRoutes);
  app.route("/", memberRoutes);
  app.route("/", invitationRoutes);
  app.route("/", projectRoutes);
  app.route("/", taskRoutes);
  app.route("/", apiKeyRoutes);
  app.route("/", billingRoutes);
  app.route("/", auditRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toBody(), error.status as 400);
    }
    if (error instanceof ZodError) {
      return c.json({ error: { code: "validation_failed", message: "Request validation failed", details: { issues: issuesOf(error) } } }, 400);
    }
    console.error(`[app] unhandled error on ${c.req.method} ${c.req.path}:`, error);
    return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
  });

  const workflows = registerWorkflows(deps);
  return { app, deps, workflows };
}

/**
 * The default instance: production dependencies from the environment (`DATABASE_URL`, `STRIPE_*`),
 * the shared `events` bus (the `averri.config.ts` spy target) and the registered workflows.
 * `src/server.ts` serves it, and Averri's generated tests drive it through `app.fetch` (the harness
 * reads the entry module's `default`/`app` and `prisma` exports). Constructing it opens no
 * connection: the Prisma client connects on its first query. Tests that need isolation build their
 * own with `createApp(deps)`.
 */
export const defaultApp: CreatedApp = createApp();
export const app: App = defaultApp.app;
export const deps: AppDeps = defaultApp.deps;
/** The client the default instance uses. */
export const prisma: AppDeps["db"] = defaultApp.deps.db;
export default app;
