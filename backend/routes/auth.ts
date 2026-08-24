import { Router } from "express";
import { register, login, refresh, logout } from "../controllers/auth";
import { requireAuth } from "../middlewares/auth";
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
router.post("/logout", requireDevice, requireAuth, logout);

export default router;
