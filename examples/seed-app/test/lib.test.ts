import { describe, expect, it } from "vitest";
import { hashPassword, hmacSha256, randomToken, safeEqual, sha256, verifyPassword } from "../src/lib/crypto.js";
import { AppError, errors, isUniqueViolation } from "../src/lib/errors.js";
import { cursorWhere, decodeCursor, encodeCursor, paginate, paginationQuerySchema } from "../src/lib/pagination.js";
import { FakeStripeClient, signStripePayload, verifyStripeSignature } from "../src/lib/stripe.js";
import { splitSqlStatements } from "../src/migrate.js";
import { deriveProjectKey } from "../src/services/projects.js";
import { effectiveStatus } from "../src/services/invitations.js";

describe("lib/crypto", () => {
  it("hashes and verifies passwords with scrypt and a fresh salt each time", () => {
    const a = hashPassword("hunter22");
    const b = hashPassword("hunter22");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("hunter22", a)).toBe(true);
    expect(verifyPassword("hunter23", a)).toBe(false);
    expect(verifyPassword("hunter22", "garbage")).toBe(false);
  });

  it("tokens are prefixed and unique; sha256/hmac are stable; safeEqual handles length mismatch", () => {
    const t1 = randomToken("usr");
    const t2 = randomToken("usr");
    expect(t1).toMatch(/^usr_[A-Za-z0-9]{30,}$/);
    expect(t1).not.toBe(t2);
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hmacSha256("key", "msg")).toHaveLength(64);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("lib/errors", () => {
  it("serialises to the envelope and recognises Prisma unique violations", () => {
    const e = errors.conflict("x_taken", "taken", { field: "x" });
    expect(e).toBeInstanceOf(AppError);
    expect(e.toBody()).toEqual({ error: { code: "x_taken", message: "taken", details: { field: "x" } } });
    expect(errors.notFound("Thing").toBody()).toEqual({ error: { code: "not_found", message: "Thing not found" } });
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});

describe("lib/pagination", () => {
  it("round-trips cursors and rejects garbage", () => {
    const key = { createdAt: new Date("2026-01-02T03:04:05.678Z"), id: "abc" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
    expect(() => decodeCursor("not-base64-json")).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ t: "nope", i: "x" })).toString("base64url"))).toThrow(AppError);
    expect(cursorWhere(undefined)).toBeUndefined();
    expect(cursorWhere(encodeCursor(key))).toEqual({ OR: [{ createdAt: { lt: key.createdAt } }, { createdAt: key.createdAt, id: { lt: "abc" } }] });
  });

  it("paginate fetches limit + 1 and reports the next cursor only when there is more", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, createdAt: new Date(1000 - i) }));
    const query = paginationQuerySchema.parse({ limit: "2" });
    const page = await paginate(query, async ({ take }) => rows.slice(0, take));
    expect(page.data.map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(page.nextCursor).toBe(encodeCursor(rows[1]!));
    const last = await paginate(paginationQuerySchema.parse({ limit: 10 }), async ({ take }) => rows.slice(0, take));
    expect(last.data).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
    expect(paginationQuerySchema.parse({}).limit).toBe(20);
    expect(() => paginationQuerySchema.parse({ limit: 0 })).toThrow();
  });
});

describe("lib/stripe signatures", () => {
  const secret = "whsec_abc";
  const body = '{"id":"evt_1","type":"x","data":{"object":{}}}';
  const now = () => new Date(1_700_000_000 * 1000);

  it("accepts a fresh valid signature, any matching v1 entry, and rejects everything else", () => {
    const header = signStripePayload(secret, body, 1_700_000_000);
    expect(verifyStripeSignature(header, body, secret, { now })).toEqual({ ok: true, timestamp: 1_700_000_000 });
    expect(verifyStripeSignature(`${header},v1=${"0".repeat(64)}`, body, secret, { now }).ok).toBe(true);
    expect(verifyStripeSignature(`t=1700000000,v1=${"0".repeat(64)},${header.split(",")[1]}`, body, secret, { now }).ok).toBe(true);
    expect(verifyStripeSignature(undefined, body, secret, { now })).toEqual({ ok: false, reason: "missing" });
    expect(verifyStripeSignature("t=abc", body, secret, { now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyStripeSignature(header, body + " ", secret, { now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(header, body, "whsec_other", { now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(signStripePayload(secret, body, 1_700_000_000 - 301), body, secret, { now })).toEqual({ ok: false, reason: "expired" });
    expect(verifyStripeSignature(signStripePayload(secret, body, 1_700_000_000 + 301), body, secret, { now })).toEqual({ ok: false, reason: "expired" });
    expect(verifyStripeSignature(signStripePayload(secret, body, 1_700_000_000 - 301), body, secret, { now, toleranceSeconds: 600 }).ok).toBe(true);
  });

  it("the fake client issues ids and remembers what it created", async () => {
    const client = new FakeStripeClient();
    const customer = await client.customers.create({ email: "a@b.c", name: "A", metadata: { organizationId: "o" } });
    expect(customer.id).toMatch(/^cus_/);
    const session = await client.checkout.sessions.create({ customer: customer.id, priceId: "price_pro", quantity: 2, successUrl: "s", cancelUrl: "c", metadata: {} });
    expect(session.url).toContain(session.id);
    expect(client.sessions_).toHaveLength(1);
  });
});

describe("misc helpers", () => {
  it("deriveProjectKey", () => {
    expect(deriveProjectKey("Customer Data Platform")).toBe("CDP");
    expect(deriveProjectKey("Website")).toBe("WEBS");
    expect(deriveProjectKey("a b c d e f")).toBe("ABCD");
    expect(deriveProjectKey("2024 Plan")).toBe("P2P");
    expect(deriveProjectKey("x")).toBe("XX");
  });

  it("effectiveStatus derives expired from expiresAt only for pending invitations", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(effectiveStatus({ status: "pending", expiresAt: new Date("2025-12-31T00:00:00Z") }, now)).toBe("expired");
    expect(effectiveStatus({ status: "pending", expiresAt: new Date("2026-01-02T00:00:00Z") }, now)).toBe("pending");
    expect(effectiveStatus({ status: "accepted", expiresAt: new Date("2025-12-31T00:00:00Z") }, now)).toBe("accepted");
  });

  it("splitSqlStatements drops comments and empty fragments", () => {
    const sql = `-- CreateTable\nCREATE TABLE "A" (\n  "id" TEXT NOT NULL PRIMARY KEY\n);\n\n-- CreateIndex\nCREATE UNIQUE INDEX "A_id_key" ON "A"("id");\n`;
    expect(splitSqlStatements(sql)).toEqual(['CREATE TABLE "A" (\n  "id" TEXT NOT NULL PRIMARY KEY\n)', 'CREATE UNIQUE INDEX "A_id_key" ON "A"("id")']);
  });
});
