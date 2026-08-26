import { Router } from "express";
import {
  getSession,
  listProjectUsers,
  listProjects,
  revokeSession,
  setUserRole,
} from "../controllers/admin";
import { requireAuth } from "../middlewares/auth";
import { requirePlatformStaff } from "../middlewares/platformStaff";

const router = Router();

// Platform-staff surface (ADR 0007 scope): session-authenticated kauth
// operators looking across all tenants. Session-only by construction —
// requireAuth rejects any request bearing only an API key before this gate.
router.get("/admin/projects", requireAuth, requirePlatformStaff, listProjects);

router.get(
  "/admin/projects/:projectId/users",
  requireAuth,
  requirePlatformStaff,
  listProjectUsers,
);

router.get(
  "/admin/sessions/:sessionId",
  requireAuth,
  requirePlatformStaff,
  getSession,
);
router.delete(
  "/admin/sessions/:sessionId",
  requireAuth,
  requirePlatformStaff,
  revokeSession,
);

// Roles are changed only within the platform Project; the controller turns
// any other target into the same 404 as a missing user.
router.post(
  "/admin/users/:userId/role",
  requireAuth,
  requirePlatformStaff,
  setUserRole,
);

export default router;
