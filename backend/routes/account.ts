import { Router } from "express";
import {
  changePassword,
  forgotPassword,
  resetPassword,
  sendVerificationEmail,
  verifyEmail,
} from "../controllers/account";
import { requireAuth } from "../middlewares/auth";
import { recoveryLimiter, tokenSubmissionLimiter } from "../middlewares/rateLimit";

const router = Router();

router.post("/send-verification-email", recoveryLimiter, sendVerificationEmail);
router.post("/verify-email", tokenSubmissionLimiter, verifyEmail);
router.post("/forgot-password", recoveryLimiter, forgotPassword);
router.post("/reset-password", tokenSubmissionLimiter, resetPassword);
router.post("/change-password", requireAuth, changePassword);

export default router;
