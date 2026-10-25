/**
 * A deliberately small Stripe client plus the webhook signature scheme.
 *
 * - `createStripeClient({ secretKey })` talks to api.stripe.com with `fetch` when a key is configured and
 *   falls back to an in-memory fake otherwise (local development and tests never touch the network).
 * - `signStripePayload` / `verifyStripeSignature` implement Stripe's `stripe-signature` header
 *   (`t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">`) over the RAW request body.
 */
import { hmacSha256, randomId, safeEqual } from "./crypto.js";
import { STRIPE_SIGNATURE_TOLERANCE_S } from "./constants.js";

export interface StripeCustomer {
  id: string;
  email: string;
  name: string;
  metadata: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  url: string;
  customer: string;
  metadata: Record<string, string>;
}

export interface StripeClient {
  readonly mode: "live" | "fake";
  customers: {
    create(params: { email: string; name: string; metadata: Record<string, string> }): Promise<StripeCustomer>;
  };
  checkout: {
    sessions: {
      create(params: {
        customer: string;
        priceId: string;
        quantity: number;
        successUrl: string;
        cancelUrl: string;
        metadata: Record<string, string>;
      }): Promise<StripeCheckoutSession>;
    };
  };
}

export class FakeStripeClient implements StripeClient {
  readonly mode = "fake" as const;
  readonly customers_: StripeCustomer[] = [];
  readonly sessions_: StripeCheckoutSession[] = [];

  customers = {
    create: async (params: { email: string; name: string; metadata: Record<string, string> }): Promise<StripeCustomer> => {
      const customer: StripeCustomer = { id: `cus_${randomId(8)}`, email: params.email, name: params.name, metadata: params.metadata };
      this.customers_.push(customer);
      return customer;
    },
  };

  checkout = {
    sessions: {
      create: async (params: {
        customer: string;
        priceId: string;
        quantity: number;
        successUrl: string;
        cancelUrl: string;
        metadata: Record<string, string>;
      }): Promise<StripeCheckoutSession> => {
        const id = `cs_${randomId(8)}`;
        const session: StripeCheckoutSession = {
          id,
          url: `https://checkout.stripe.test/pay/${id}`,
          customer: params.customer,
          metadata: { ...params.metadata, priceId: params.priceId, quantity: String(params.quantity) },
        };
        this.sessions_.push(session);
        return session;
      },
    },
  };
}

function formEncode(params: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const name = prefix === "" ? key : `${prefix}[${key}]`;
    if (value === undefined || value === null) continue;
    if (typeof value === "object") parts.push(...formEncode(value as Record<string, unknown>, name));
    else parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts;
}

export class HttpStripeClient implements StripeClient {
  readonly mode = "live" as const;
  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor(secretKey: string, baseUrl = "https://api.stripe.com/v1") {
    this.secretKey = secretKey;
    this.baseUrl = baseUrl;
  }

  private async post<T>(path: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: formEncode(params).join("&"),
    });
    if (!response.ok) {
      throw new Error(`Stripe ${path} failed with ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  customers = {
    create: (params: { email: string; name: string; metadata: Record<string, string> }) => this.post<StripeCustomer>("/customers", params),
  };

  checkout = {
    sessions: {
      create: async (params: {
        customer: string;
        priceId: string;
        quantity: number;
        successUrl: string;
        cancelUrl: string;
        metadata: Record<string, string>;
      }): Promise<StripeCheckoutSession> =>
        this.post<StripeCheckoutSession>("/checkout/sessions", {
          mode: "subscription",
          customer: params.customer,
          success_url: params.successUrl,
          cancel_url: params.cancelUrl,
          line_items: { 0: { price: params.priceId, quantity: params.quantity } },
          metadata: params.metadata,
        }),
    },
  };
}

export function createStripeClient(options: { secretKey?: string | undefined } = {}): StripeClient {
  return options.secretKey ? new HttpStripeClient(options.secretKey) : new FakeStripeClient();
}

/** Default client used by `src/server.ts` and referenced by the `Stripe` integration declaration. */
export const stripe: StripeClient = createStripeClient({ secretKey: process.env.STRIPE_SECRET_KEY });

// ---------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------

/** Build a `stripe-signature` header value for `rawBody` (used by tests and local tooling). */
export function signStripePayload(secret: string, rawBody: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${hmacSha256(secret, `${timestampSeconds}.${rawBody}`)}`;
}

export type SignatureVerification = { ok: true; timestamp: number } | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

/**
 * Verify a `stripe-signature` header against the RAW body. Any `v1` entry may match (Stripe sends
 * several during secret rollover). Timestamps older than `toleranceSeconds` are rejected to limit replay.
 */
export function verifyStripeSignature(
  header: string | undefined,
  rawBody: string,
  secret: string,
  options: { now?: () => Date; toleranceSeconds?: number } = {},
): SignatureVerification {
  if (header === undefined || header.trim() === "") return { ok: false, reason: "missing" };
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) timestamp = n;
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "malformed" };
  const nowSeconds = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
  const tolerance = options.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_S;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return { ok: false, reason: "expired" };
  const expected = hmacSha256(secret, `${timestamp}.${rawBody}`);
  for (const signature of signatures) {
    if (safeEqual(signature, expected)) return { ok: true, timestamp };
  }
  return { ok: false, reason: "mismatch" };
}
