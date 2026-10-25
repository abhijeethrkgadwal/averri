import { Hono } from "hono";
import { prisma } from "./db.js";
import { auth } from "./middleware.js";

export const app = new Hono<{ Variables: { actor: { id: string } } }>();

app.use("/notes/*", auth);
app.use("/notes", auth);

app.post("/notes", async (c) => {
  const body = (await c.req.json()) as { title: string };
  const note = await prisma.note.create({ data: { ownerId: c.get("actor").id, title: body.title } });
  return c.json(note, 201);
});

app.get("/notes", async (c) => {
  const notes = await prisma.note.findMany({ where: { ownerId: c.get("actor").id } });
  return c.json(notes);
});

export default app;
