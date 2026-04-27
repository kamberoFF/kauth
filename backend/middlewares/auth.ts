import { type Response, type NextFunction } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { type AuthRequest } from "../types/auth";

export const protect = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "No token provided" });

  const payload = verifyAccessToken(token);
  if (!payload)
    return res.status(401).json({ error: "Invalid or expired token" });

  // Attach to request for downstream use (type-safe)
  req.userId = payload.userId;
  next();
};
