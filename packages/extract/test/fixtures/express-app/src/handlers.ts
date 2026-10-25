import type { Request, Response } from "express";
import { InviteInput } from "./schemas.js";

export function listTeams(_req: Request, res: Response) {
  res.json([]);
}

export function inviteMember(req: Request, res: Response) {
  const body = InviteInput.parse(req.body);
  res.json(body);
}

export function removeMember(req: Request, res: Response) {
  res.json({ removed: req.params["userId"] });
}

export function me(_req: Request, res: Response) {
  res.json({ id: "me" });
}

export function statusHandler(_req: Request, res: Response) {
  res.send("posted");
}
