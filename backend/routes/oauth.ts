import { Router } from "express";
import {
  exchangeOAuthCode,
  listProviders,
  oauthCallback,
  startOAuth,
} from "../controllers/oauth";
import { requireDevice } from "../middlewares/device";
import { oauthLimiter } from "../middlewares/rateLimit";

const router = Router();

// Declared before the :provider route so the literal path wins.
router.get("/oauth/providers", listProviders);

router.post("/oauth/exchange", oauthLimiter, requireDevice, exchangeOAuthCode);

router.get("/oauth/:provider", oauthLimiter, startOAuth);
router.get("/oauth/:provider/callback", oauthLimiter, oauthCallback);

export default router;
