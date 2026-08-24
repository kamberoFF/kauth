import { Router } from "express";
import {
  exchangeOAuthCode,
  listProviders,
  oauthCallback,
  startOAuth,
} from "../controllers/oauth";
import { resolveDevice } from "../middlewares/device";
import { oauthLimiter } from "../middlewares/rateLimit";

const router = Router();

// Declared before the :provider route so the literal path wins.
router.get("/oauth/providers", listProviders);

// resolveDevice, not requireDevice: the callback redirect cannot carry a
// device id and a first-time browser has no kauth_device cookie yet, so the
// exchange is a session-creating endpoint that mints when nothing is echoed —
// same contract as /register and /login.
router.post("/oauth/exchange", oauthLimiter, resolveDevice, exchangeOAuthCode);

router.get("/oauth/:provider", oauthLimiter, startOAuth);
router.get("/oauth/:provider/callback", oauthLimiter, oauthCallback);

export default router;
