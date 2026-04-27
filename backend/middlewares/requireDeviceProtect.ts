import { type Response, type NextFunction } from "express";
import { type AuthDeviceRequest } from "../types/auth";
import { verifyAccessToken } from "../lib/jwt";

// Simple UUID v4 regex
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const requireDeviceProtect = (
  req: AuthDeviceRequest,
  res: Response,
  next: NextFunction,
) => {
  const deviceId = req.get("x-device-id")?.trim();

  if (!deviceId) {
    return res
      .status(400)
      .json({ error: "Missing required header: x-device-id" });
  }

  // ✅ Validate format BEFORE proceeding
  if (!UUID_REGEX.test(deviceId)) {
    return res.status(400).json({
      error: "Invalid x-device-id format. Must be a valid UUID v4",
    });
  }

  req.deviceId = deviceId;

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
