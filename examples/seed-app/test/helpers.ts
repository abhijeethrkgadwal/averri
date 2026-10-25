/**
 * Test harness: one fresh SQLite database per test file (schema applied from the committed migration
 * SQL, no CLI spawn), an isolated event bus, an in-memory mailer, the fake Stripe client and a
 * controllable clock. Requests go through `app.request()`; no port is opened.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp, type CreatedApp } from "../src/app.js";
import type { AppConfig } from "../src/context.js";
import { createPrismaClient, type PrismaClient } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { MemoryMailer } from "../src/lib/mailer.js";
import { FakeStripeClient, signStripePayload } from "../src/lib/stripe.js";
import { applyMigrations } from "../src/migrate.js";
import { seedDatabase, SEED, type SeedData } from "../src/seed.js";

export const TEST_CONFIG: AppConfig = {
  stripeWebhookSecret: "whsec_test_secret",
  stripePrices: { pro: "price_pro", enterprise: "price_enterprise" },
  appBaseUrl: "http://app.test",
};

export interface TestContext extends CreatedApp {
  db: PrismaClient;
  events: EventBus;
  mailer: MemoryMailer;
  stripe: FakeStripeClient;
  clock: { now: Date; set(date: Date): void; advance(ms: number): void };
  seed: SeedData;
  /** Perform a request; `as` is a seed user key, an explicit bearer token, or undefined for anonymous. */
  request(method: string, url: string, options?: RequestOptions): Promise<TestResponse>;
  close(): Promise<void>;
}

export interface RequestOptions {
  as?: keyof SeedData["users"] | { token: string } | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export interface TestResponse {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

export async function createTestContext(options: { seed?: boolean } = {}): Promise<TestContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "averri-seed-app-"));
  const file = path.join(dir, `${randomUUID()}.db`).replace(/\\/g, "/");
  const db = createPrismaClient(`file:${file}`);
  await applyMigrations(db);

  const clockState = { now: new Date("2026-10-24T12:00:00.000Z") };
  const clock = {
    get now() {
      return clockState.now;
    },
    set(date: Date) {
      clockState.now = date;
    },
    advance(ms: number) {
      clockState.now = new Date(clockState.now.getTime() + ms);
    },
  };
  const events = new EventBus();
  const mailer = new MemoryMailer();
  const stripe = new FakeStripeClient();
  const created = createApp({ db, events, mailer, stripe, config: TEST_CONFIG, now: () => clockState.now });
  if (options.seed !== false) await seedDatabase({ db, now: () => clockState.now });

  async function request(method: string, url: string, opts: RequestOptions = {}): Promise<TestResponse> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.as !== undefined && opts.as !== null) {
      const token = typeof opts.as === "string" ? SEED.users[opts.as].token : opts.as.token;
      headers.authorization = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      headers["content-type"] ??= "application/json";
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] ??= "application/json";
    }
    const response = await created.app.request(url, { method, headers, body });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  return {
    ...created,
    db,
    events,
    mailer,
    stripe,
    clock,
    seed: SEED,
    request,
    async close() {
      created.workflows.dispose();
      await db.$disconnect();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Build a signed Stripe webhook delivery for `ctx` (uses the test secret and the test clock). */
export function signedStripeRequest(ctx: TestContext, event: Record<string, unknown>, options: { rawBody?: string; secret?: string; timestamp?: number } = {}) {
  const rawBody = options.rawBody ?? JSON.stringify(event);
  const timestamp = options.timestamp ?? Math.floor(ctx.clock.now.getTime() / 1000);
  const signature = signStripePayload(options.secret ?? TEST_CONFIG.stripeWebhookSecret, rawBody, timestamp);
  return { rawBody, headers: { "stripe-signature": signature, "content-type": "application/json" } };
}

export function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`) {
  return { id, object: "event", type, created: 1_760_000_000, data: { object } };
}
