import { Router } from "express";
import {
  listProjectUsers,
  revokeProjectSession,
  verifyProjectSession,
} from "../controllers/projectAccess";
import {
  listProjectEventsHandler,
  listProjectSessionsHandler,
} from "../controllers/projectManagement";
import { requireSecretKey } from "../middlewares/apiKey";

const router = Router();

// Secret-key-only elevated operations. Flat and implicitly project-scoped —
// the key itself resolves the project, the same way refresh derives project
// from the stored token row rather than a client-supplied header.
router.get("/project/users", requireSecretKey, listProjectUsers);
// The list and the by-id lookup are distinct Express routes and coexist —
// `/project/sessions` never matches the `:sessionId` pattern.
router.get("/project/sessions", requireSecretKey, listProjectSessionsHandler);
router.get(
  "/project/sessions/:sessionId",
  requireSecretKey,
  verifyProjectSession,
);
router.delete(
  "/project/sessions/:sessionId",
  requireSecretKey,
  revokeProjectSession,
);

// The Project's own security-event log, for a downstream backend that wants to
// stream it into its own tooling. Scoped to the key's Project, never a
// client-supplied id — same query and shape as the owner route.
router.get("/project/events", requireSecretKey, listProjectEventsHandler);

export default router;
