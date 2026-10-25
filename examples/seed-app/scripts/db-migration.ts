/**
 * `npm run db:migration`: regenerate prisma/migrations/0001_init/migration.sql from the schema.
 * The test suite applies this file directly (src/migrate.ts), so rerun it after every schema change.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = path.join(root, "prisma", "schema.prisma");
const target = path.join(root, "prisma", "migrations", "0001_init", "migration.sql");

const result = spawnSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", schema, "--script"], {
  encoding: "utf8",
  shell: true,
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "file:./dev.db" },
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
writeFileSync(target, result.stdout.replace(/\r\n/g, "\n"), "utf8");
console.log(`Wrote ${target}`);
