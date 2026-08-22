// backend/types/express.d.ts
import "express";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
      deviceId?: string;
      projectId?: string;
      csrfToken?: string;
      apiKeyId?: string;
      apiKeyType?: "PUBLISHABLE" | "SECRET";
    }
  }
}

export {};
