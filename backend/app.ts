import express from "express";
import { requireAuth } from "./middlewares/auth";
import { requireDevice } from "./middlewares/device";
import { register, login, refresh, logout } from "./controllers/auth";
import type { AuthRequest } from "./types/auth";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import config from "./config";

const FRONTEND_URL = config.frontend_url;
const COOKIE_SECRET = config.cookie_secret;

const app = express();

// app.set("trust proxy", 1); // only if behind proxy/reverse proxy like Nginx, Render, Railway, Fly, etc.
app.disable("x-powered-by");

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
        "connect-src": ["'self'", FRONTEND_URL],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
      },
    },
  }),
);

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "X-Device-Id",
    ],
  }),
);

app.use(express.json({ limit: "32kb" }));
app.use(cookieParser(COOKIE_SECRET));

app.get("/", (req, res) => res.send("Hello World!"));

app.post("/register", requireDevice, register);
app.post("/login", requireDevice, login);
app.post("/refresh", requireDevice, requireAuth, refresh);
app.post("/logout", requireDevice, requireAuth, logout);

app.get("/protected", requireAuth, (req: AuthRequest, res) => {
  res.json({ message: "Authorized", userId: req.userId });
});

export default app;
