import { Router } from "express";
import {
  getMfaStatus,
  startMfaEnrollment,
  verifyMfaEnrollment,
} from "../controllers/mfa";
import { requireAuth } from "../middlewares/auth";
import { tokenSubmissionLimiter } from "../middlewares/rateLimit";

const router = Router();

router.post("/mfa/enrollment", requireAuth, startMfaEnrollment);
// The limiter sits behind requireAuth so only authenticated code submissions
// spend the shared IP budget; unauthenticated noise dies at the cheaper check.
router.post(
  "/mfa/enrollment/verify",
  requireAuth,
  tokenSubmissionLimiter,
  verifyMfaEnrollment,
);
router.get("/mfa", requireAuth, getMfaStatus);

export default router;
