import { Router } from "express";
import { createProject } from "../controllers/projects";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.post("/projects", requireAuth, createProject);

export default router;
