import { Router } from "express";
import {
  listProjectUsers,
  revokeProjectSession,
  verifyProjectSession,
} from "../controllers/projectAccess";
import { requireSecretKey } from "../middlewares/apiKey";

const router = Router();

// Secret-key-only elevated operations. Flat and implicitly project-scoped —
// the key itself resolves the project, the same way refresh derives project
// from the stored token row rather than a client-supplied header.
router.get("/project/users", requireSecretKey, listProjectUsers);
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

export default router;
