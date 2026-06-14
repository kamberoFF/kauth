// utils/requestGuards.ts
import type { Request } from "express";
import { appError } from "../utils/errors";

export function requireDeviceId(req: Request): string {
  if (!req.deviceId) {
    throw appError(
      500,
      "Device id missing. Did you forget requireDevice middleware?",
      "device_context_missing",
    );
  }

  return req.deviceId;
}

export function requireUserId(req: Request): string {
  if (!req.userId) {
    throw appError(
      500,
      "User id missing. Did you forget requireAuth middleware?",
      "auth_context_missing",
    );
  }

  return req.userId;
}
