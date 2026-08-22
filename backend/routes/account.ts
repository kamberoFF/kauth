import { Router } from "express";
import {
  changePassword,
  forgotPassword,
  listLinkedAccounts,
  resetPassword,
  sendVerificationEmail,
  unlinkAccount,
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
router.get("/accounts", requireAuth, listLinkedAccounts);
router.delete("/accounts/:providerId", requireAuth, unlinkAccount);

export default router;
