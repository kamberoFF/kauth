import { Router } from "express";
import { register, login, refresh, logout } from "../controllers/auth";
import { requireAuthMfaExempt } from "../middlewares/auth";
import { requireDevice, resolveDevice } from "../middlewares/device";
import { resolveProjectFromKeyOrHeader } from "../middlewares/apiKey";
import {
  loginAccountLimiter,
  loginIpLimiter,
  refreshLimiter,
  registerAccountLimiter,
  registerLimiter,
} from "../middlewares/rateLimit";

const router = Router();

// No `resolveDevice`: register no longer establishes a device or a session,
// so a missing or malformed device header is not its concern — device
// identity is established at /login (ADR 0008). `registerAccountLimiter`
// sits behind the by-IP `registerLimiter` for mailbomb parity with recovery.
router.post(
  "/register",
  resolveProjectFromKeyOrHeader,
  registerLimiter,
  registerAccountLimiter,
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
