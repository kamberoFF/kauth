import { type RequestHandler } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { appError } from "../utils/errors";

export const requireAuth: RequestHandler = (req, _res, next) => {
  const [scheme, token] = req.headers.authorization?.split(" ") ?? [];

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return next(appError(401, "No token provided", "token_missing"));
  }

  const payload = verifyAccessToken(token);

  if (!payload) {
    return next(appError(401, "Invalid or expired token", "token_invalid"));
  }

  req.userId = payload.userId;
  next();
};
