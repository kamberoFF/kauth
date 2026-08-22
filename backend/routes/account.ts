import { Router } from "express";
import {
  changePassword,
  forgotPassword,
  resetPassword,
  sendVerificationEmail,
  verifyEmail,
} from "../controllers/account";
import { requireAuth } from "../middlewares/auth";
import { requireProject } from "../middlewares/project";
import { recoveryLimiter, tokenSubmissionLimiter } from "../middlewares/rateLimit";

const router = Router();

router.post(
  "/send-verification-email",
  requireProject,
  recoveryLimiter,
  sendVerificationEmail,
);
router.post("/verify-email", tokenSubmissionLimiter, verifyEmail);
router.post(
  "/forgot-password",
  requireProject,
  recoveryLimiter,
  forgotPassword,
);
router.post("/reset-password", tokenSubmissionLimiter, resetPassword);
router.post("/change-password", requireAuth, changePassword);

export default router;
