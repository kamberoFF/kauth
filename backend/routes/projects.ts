import { Router } from "express";
import { createProject } from "../controllers/projects";
import {
  getApiKey,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
} from "../controllers/apiKeys";
import { requireAuth } from "../middlewares/auth";
import { requireProjectOwnership } from "../middlewares/projectOwnership";

const router = Router();

router.post("/projects", requireAuth, createProject);

// Project-management: session-only, never reachable by any API key — a
// request bearing only a key 401s on requireAuth before requireProjectOwnership
// (or any key logic) ever runs.
router.post(
  "/projects/:projectId/keys",
  requireAuth,
  requireProjectOwnership,
  issueApiKey,
);
router.get(
  "/projects/:projectId/keys",
  requireAuth,
  requireProjectOwnership,
  listApiKeys,
);
router.get(
  "/projects/:projectId/keys/:keyId",
  requireAuth,
  requireProjectOwnership,
  getApiKey,
);
router.delete(
  "/projects/:projectId/keys/:keyId",
  requireAuth,
  requireProjectOwnership,
  revokeApiKey,
);

export default router;
