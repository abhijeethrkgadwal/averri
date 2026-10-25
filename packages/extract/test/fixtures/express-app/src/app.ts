import express from "express";
import { auth } from "./middleware/auth.js";
import { teamsRouter } from "./routes/teams.js";
import usersRouter from "./routes/users.js";
import { statusHandler } from "./handlers.js";

export const app = express();

app.use(express.json());
app.use("/teams", auth(), teamsRouter);
app.use("/users", usersRouter);
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app
  .route("/status")
  .get((_req, res) => {
    res.send("ok");
  })
  .post(statusHandler);

export default app;
