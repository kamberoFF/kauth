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

export function requireApiKeyId(req: Request): string {
  if (!req.apiKeyId) {
    throw appError(
      500,
      "API key id missing. Did you forget requireApiKey middleware?",
      "api_key_context_missing",
    );
  }

  return req.apiKeyId;
}

export function requireProjectId(req: Request): string {
  if (!req.projectId) {
    throw appError(
      500,
      "Project id missing. Did you forget requireProject middleware?",
      "project_context_missing",
    );
  }

  return req.projectId;
}
