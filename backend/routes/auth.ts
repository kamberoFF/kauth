import { Router } from "express";
import { register, login, refresh, logout } from "../controllers/auth";
import { requireAuth } from "../middlewares/auth";
import { requireDevice } from "../middlewares/device";
import { requireProject } from "../middlewares/project";
import {
  loginAccountLimiter,
  loginIpLimiter,
  refreshLimiter,
  registerLimiter,
} from "../middlewares/rateLimit";

const router = Router();

router.post(
  "/register",
  requireProject,
  registerLimiter,
  requireDevice,
  register,
);
router.post(
  "/login",
  requireProject,
  loginIpLimiter,
  loginAccountLimiter,
  requireDevice,
  login,
);
router.post("/refresh", refreshLimiter, requireDevice, refresh);
router.post("/logout", requireDevice, requireAuth, logout);

export default router;
