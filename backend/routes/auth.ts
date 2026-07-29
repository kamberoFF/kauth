import { Router } from "express";
import { register, login, refresh, logout } from "../controllers/auth";
import { requireAuth } from "../middlewares/auth";
import { requireDevice } from "../middlewares/device";
import {
  loginAccountLimiter,
  loginIpLimiter,
  refreshLimiter,
  registerLimiter,
} from "../middlewares/rateLimit";

const router = Router();

router.post("/register", registerLimiter, requireDevice, register);
router.post("/login", loginIpLimiter, loginAccountLimiter, requireDevice, login);
router.post("/refresh", refreshLimiter, requireDevice, refresh);
router.post("/logout", requireDevice, requireAuth, logout);

export default router;
