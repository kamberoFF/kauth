import { Router } from "express";
import { listProjects } from "../controllers/admin";
import { requireAuth } from "../middlewares/auth";
import { requirePlatformStaff } from "../middlewares/platformStaff";

const router = Router();

// Platform-staff surface (ADR 0007 scope): session-authenticated kauth
// operators looking across all tenants. Session-only by construction —
// requireAuth rejects any request bearing only an API key before this gate.
router.get("/admin/projects", requireAuth, requirePlatformStaff, listProjects);

export default router;
