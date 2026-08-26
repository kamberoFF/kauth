import { Router } from "express";
import {
  disableMfa,
  getMfaStatus,
  startMfaEnrollment,
  verifyMfaChallenge,
  verifyMfaEnrollment,
} from "../controllers/mfa";
import { requireAuthMfaExempt } from "../middlewares/auth";
import { resolveDevice } from "../middlewares/device";
import { tokenSubmissionLimiter } from "../middlewares/rateLimit";

const router = Router();

// Phase two of an enrolled sign-in: deliberately before requireAuth, since no
// session exists yet. resolveDevice (not requireDevice) matches the other
// session-creating endpoints; a minted id simply cannot satisfy the token's
// device binding.
router.post("/mfa/challenge", resolveDevice, tokenSubmissionLimiter, verifyMfaChallenge);

// Every authenticated route here uses requireAuthMfaExempt: under an MFA
// mandate these are the self-service escape hatches, so a walled user can
// always reach enrollment, status, and disable. The limiter still sits behind
// auth so only authenticated code submissions spend the shared IP budget.
router.post("/mfa/enrollment", requireAuthMfaExempt, startMfaEnrollment);
router.post(
  "/mfa/enrollment/verify",
  requireAuthMfaExempt,
  tokenSubmissionLimiter,
  verifyMfaEnrollment,
);
router.get("/mfa", requireAuthMfaExempt, getMfaStatus);
router.delete("/mfa", requireAuthMfaExempt, tokenSubmissionLimiter, disableMfa);

export default router;
