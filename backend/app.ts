import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import config from "./config";
import authRoutes from "./routes/auth";
import accountRoutes from "./routes/account";
import oauthRoutes from "./routes/oauth";
import sessionsRoutes from "./routes/sessions";
import projectsRoutes from "./routes/projects";
import projectAccessRoutes from "./routes/projectAccess";
import { requireAuth } from "./middlewares/auth";
import { errorHandler, notFoundHandler } from "./middlewares/error";
import { globalLimiter } from "./middlewares/rateLimit";
import { requireTrustedOrigin } from "./middlewares/origin";
import { requestLog } from "./middlewares/requestLog";
import { issueCsrfToken, requireCsrfToken } from "./middlewares/csrf";
import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";
import {
  API_KEY_HEADER,
  CSRF_TOKEN_HEADER,
  DEVICE_ID_HEADER,
  PROJECT_ID_HEADER,
  TOKEN_RESPONSE_HEADER,
} from "./constants/headers";

const app = express();

app.set("trust proxy", config.trust_proxy);
app.disable("x-powered-by");

app.use(requestLog);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "same-site" },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"], // tighten later if possible
        "img-src": ["'self'", "data:", "https:"],
        "connect-src": ["'self'", config.frontend_url],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
      },
    },
  }),
);

app.use(
  cors({
    origin: config.frontend_url,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      CSRF_TOKEN_HEADER,
      DEVICE_ID_HEADER,
      PROJECT_ID_HEADER,
      TOKEN_RESPONSE_HEADER,
      API_KEY_HEADER,
    ],
  }),
);

app.use(express.json({ limit: "32kb" }));
app.use(cookieParser(config.cookie_secret));
app.use(globalLimiter);
app.use(requireTrustedOrigin);
app.use(requireCsrfToken);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Liveness above stays a static response — "the process is alive" must never
// depend on the database. This one is real: deployment automation uses it to
// tell "alive" apart from "can actually serve requests".
app.get("/health/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (error) {
    logger.error("readiness check failed", { error });
    res.status(503).json({
      error: { message: "Database unavailable", code: "database_unavailable" },
    });
  }
});

app.get("/csrf-token", (_req, res) => {
  res.json({ csrfToken: issueCsrfToken(res) });
});

app.use(authRoutes);
app.use(accountRoutes);
app.use(oauthRoutes);
app.use(sessionsRoutes);
app.use(projectsRoutes);
app.use(projectAccessRoutes);

app.get("/protected", requireAuth, (req, res) => {
  res.json({ message: "Authorized", userId: req.userId });
});

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
