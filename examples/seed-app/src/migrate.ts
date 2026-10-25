/**
 * Applies the committed SQL migrations to a database through the Prisma client. Used by the test
 * suite (one fresh SQLite file per test file, no CLI spawn) and by `scripts/db-push.ts` as a fallback.
 * `prisma migrate diff` regenerates the SQL (`npm run db:migration`).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "..", "prisma", "migrations");

/** Split a migration file into executable statements (Prisma emits one statement per `;` at line end). */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) =>
      s
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

export async function listMigrations(): Promise<Array<{ name: string; sql: string }>> {
  const entries = (await readdir(MIGRATIONS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const out: Array<{ name: string; sql: string }> = [];
  for (const name of entries) {
    out.push({ name, sql: await readFile(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8") });
  }
  return out;
}

export async function applyMigrations(db: PrismaClient): Promise<string[]> {
  const applied: string[] = [];
  for (const migration of await listMigrations()) {
    for (const statement of splitSqlStatements(migration.sql)) {
      await db.$executeRawUnsafe(statement);
    }
    applied.push(migration.name);
  }
  return applied;
}
