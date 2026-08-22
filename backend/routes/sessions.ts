import { Router } from "express";
import { listSessions, revokeSession } from "../controllers/sessions";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/sessions", requireAuth, listSessions);
router.delete("/sessions/:sessionId", requireAuth, revokeSession);

export default router;
