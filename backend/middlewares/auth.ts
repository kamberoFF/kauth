import { type RequestHandler } from "express";
import { verifyAccessToken } from "../lib/jwt";

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  if (!token) {
    res.status(401).json({ error: "No token provided" });

    return;
  }

  const payload = verifyAccessToken(token);

  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });

    return;
  }

  // Attach to request for downstream use (type-safe)
  req.userId = payload.userId;
  next();
};
