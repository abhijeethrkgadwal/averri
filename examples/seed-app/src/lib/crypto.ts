/**
 * Hashing and token helpers. Secrets (auth tokens, API keys) are stored as SHA-256 hashes; passwords
 * use scrypt with a per-user salt. Everything is `node:crypto`; no third-party dependency.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

/** Constant-time string comparison that does not leak length through an exception. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** A random token `<prefix>_<base62-ish>`; 32 random bytes of entropy. */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url").replace(/[-_]/g, "")}`;
}

export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString("hex");
}

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || salt === undefined || hash === undefined) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return safeEqual(candidate, hash);
}
