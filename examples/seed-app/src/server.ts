/**
 * Local entry point: `npm run dev` (or `npm start`). Reads DATABASE_URL / PORT / STRIPE_* from the
 * environment; see `.env.example`.
 */
import { serve } from "@hono/node-server";
import { app, deps } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`seed-app listening on http://localhost:${info.port} (stripe client: ${deps.stripe.mode})`);
});

async function shutdown(): Promise<void> {
  server.close();
  await deps.db.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
