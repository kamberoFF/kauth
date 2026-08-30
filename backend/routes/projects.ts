import { Router } from "express";
import { createProject, updateProject } from "../controllers/projects";
import {
  getApiKey,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
} from "../controllers/apiKeys";
import {
  getProjectSessionHandler,
  listProjectEventsHandler,
  listProjectSessionsHandler,
  listProjectUsersHandler,
  revokeProjectSessionHandler,
} from "../controllers/projectManagement";
import {
  deleteProjectOAuthProvider,
  listProjectOAuthProviders,
  putProjectOAuthProvider,
} from "../controllers/projectOAuthProviders";
import { requireAuth } from "../middlewares/auth";
import { requireProjectOwnership } from "../middlewares/projectOwnership";

const router = Router();

router.post("/projects", requireAuth, createProject);

// Owner-only settings update — session-authenticated like creation, never
// reachable by an API key.
router.patch(
  "/projects/:projectId",
  requireAuth,
  requireProjectOwnership,
  updateProject,
);

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

// Owner management reads over the Project's own contents — session-only, same
// as the routes above. A request bearing only a key 401s on requireAuth
// before requireProjectOwnership ever runs.
router.get(
  "/projects/:projectId/events",
  requireAuth,
  requireProjectOwnership,
  listProjectEventsHandler,
);
router.get(
  "/projects/:projectId/users",
  requireAuth,
  requireProjectOwnership,
  listProjectUsersHandler,
);
router.get(
  "/projects/:projectId/sessions",
  requireAuth,
  requireProjectOwnership,
  listProjectSessionsHandler,
);
router.get(
  "/projects/:projectId/sessions/:sessionId",
  requireAuth,
  requireProjectOwnership,
  getProjectSessionHandler,
);
router.delete(
  "/projects/:projectId/sessions/:sessionId",
  requireAuth,
  requireProjectOwnership,
  revokeProjectSessionHandler,
);

// Per-Project OAuth Provider apps (ADR 0009) — owner session only, same
// never-reachable-by-a-key rule as the routes above.
router.get(
  "/projects/:projectId/oauth/providers",
  requireAuth,
  requireProjectOwnership,
  listProjectOAuthProviders,
);
router.put(
  "/projects/:projectId/oauth/providers/:provider",
  requireAuth,
  requireProjectOwnership,
  putProjectOAuthProvider,
);
router.delete(
  "/projects/:projectId/oauth/providers/:provider",
  requireAuth,
  requireProjectOwnership,
  deleteProjectOAuthProvider,
);

export default router;
