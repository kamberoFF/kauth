import { Router } from "express";
import {
  disableMfa,
  getMfaStatus,
  startMfaEnrollment,
  verifyMfaChallenge,
  verifyMfaEnrollment,
} from "../controllers/mfa";
import { requireAuth } from "../middlewares/auth";
import { resolveDevice } from "../middlewares/device";
import { tokenSubmissionLimiter } from "../middlewares/rateLimit";

const router = Router();

// Phase two of an enrolled sign-in: deliberately before requireAuth, since no
// session exists yet. resolveDevice (not requireDevice) matches the other
// session-creating endpoints; a minted id simply cannot satisfy the token's
// device binding.
router.post("/mfa/challenge", resolveDevice, tokenSubmissionLimiter, verifyMfaChallenge);

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
// Step-up disable: same limiter placement as the verify route — only
// authenticated code submissions spend the shared IP budget.
router.delete("/mfa", requireAuth, tokenSubmissionLimiter, disableMfa);

export default router;
