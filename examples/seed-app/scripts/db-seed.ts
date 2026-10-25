/**
 * `npm run db:seed`: wipe and reload the deterministic seed data set (see src/seed.ts).
 */
import { createPrismaClient, defaultDatabaseUrl } from "../src/db.js";
import { resetDatabase, seedDatabase, SEED } from "../src/seed.js";

process.env.DATABASE_URL ??= defaultDatabaseUrl();
const db = createPrismaClient();

try {
  await resetDatabase(db);
  await seedDatabase({ db, now: () => new Date() });
  console.log(`Seeded ${process.env.DATABASE_URL}`);
  console.log("Users (password: password123):");
  for (const user of Object.values(SEED.users)) console.log(`  ${user.email.padEnd(26)} token: ${user.token}`);
  console.log(`API keys: ${Object.values(SEED.apiKeys).map((k) => k.secret).join(", ")}`);
} finally {
  await db.$disconnect();
}
