/**
 * Prisma client factory. The URL comes from `DATABASE_URL` (SQLite locally; Postgres is a one-line
 * change in `prisma/schema.prisma`). Tests pass their own URL so each test file gets an isolated database.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

export { Prisma, PrismaClient };

/** Transaction client as seen inside `prisma.$transaction(async (tx) => ...)`. */
export type Tx = Prisma.TransactionClient;
/** Either client; services accept both so they compose inside transactions. */
export type Db = PrismaClient | Tx;

const here = path.dirname(fileURLToPath(import.meta.url));

/** `file:<absolute path>/prisma/dev.db`, the local default. */
export function defaultDatabaseUrl(): string {
  return `file:${path.resolve(here, "..", "prisma", "dev.db").replace(/\\/g, "/")}`;
}

export function resolveDatabaseUrl(explicit?: string): string {
  return explicit ?? process.env.DATABASE_URL ?? defaultDatabaseUrl();
}

export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: resolveDatabaseUrl(url),
    log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["error"],
  });
}
