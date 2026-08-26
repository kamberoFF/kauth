import { Router } from "express";
import { register, login, refresh, logout } from "../controllers/auth";
import { requireAuthMfaExempt } from "../middlewares/auth";
import { requireDevice, resolveDevice } from "../middlewares/device";
import { resolveProjectFromKeyOrHeader } from "../middlewares/apiKey";
import {
  loginAccountLimiter,
  loginIpLimiter,
  refreshLimiter,
  registerLimiter,
} from "../middlewares/rateLimit";

const router = Router();

router.post(
  "/register",
  resolveProjectFromKeyOrHeader,
  registerLimiter,
  resolveDevice,
  register,
);
router.post(
  "/login",
  resolveProjectFromKeyOrHeader,
  loginIpLimiter,
  loginAccountLimiter,
  resolveDevice,
  login,
);
router.post("/refresh", refreshLimiter, requireDevice, refresh);
// Logout is exempt from the MFA wall: a walled user must always be able to
// leave rather than being held in a session they cannot use.
router.post("/logout", requireDevice, requireAuthMfaExempt, logout);

export default router;
