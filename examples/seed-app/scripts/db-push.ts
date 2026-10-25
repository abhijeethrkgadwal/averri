/**
 * `npm run db:push`: create or update the local SQLite database from the Prisma schema.
 * Defaults DATABASE_URL to prisma/dev.db when unset so the command works on a fresh checkout.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDatabaseUrl } from "../src/db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL ??= defaultDatabaseUrl();

const result = spawnSync("npx", ["prisma", "db", "push", "--schema", path.join(root, "prisma", "schema.prisma"), "--skip-generate"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});
process.exit(result.status ?? 1);
