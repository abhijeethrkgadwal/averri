/**
 * Vitest setup for the seed app (runs before every test file in this project).
 *
 * Averri's generated tests (`tests/averri/*.gen.test.ts`) import the configured entry point
 * (`src/main.ts`), whose default instance reads `DATABASE_URL` at import time. This file gives every
 * test file its own SQLite database (committed migration applied, deterministic seed data loaded,
 * so the actor fixtures' bearer tokens in `averri.config.ts` resolve) before the test module is
 * imported, and pins the webhook secret the generated Stripe tests sign with. Hand-written tests
 * build their own isolated context (`test/helpers.ts`) and are unaffected.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { createPrismaClient } from "../src/db.js";
import { applyMigrations } from "../src/migrate.js";
import { seedDatabase } from "../src/seed.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "averri-seed-gen-"));
const url = `file:${path.join(dir, `${randomUUID()}.db`).split(path.sep).join("/")}`;
const db = createPrismaClient(url);
try {
  await applyMigrations(db);
  await seedDatabase({ db, now: () => new Date() });
} finally {
  await db.$disconnect();
}

process.env.DATABASE_URL = url;
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_secret";

afterAll(async () => {
  // Best effort: on Windows the app's client may still hold the file until the worker exits.
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});
