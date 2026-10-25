import { Router } from "express";
import { me } from "../handlers.js";

const router = Router();

router.get("/me", me);

export default router;
