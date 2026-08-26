// backend/types/express.d.ts
import "express";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      userId?: string;
      sessionId?: string;
      deviceId?: string;
      projectId?: string;
      userRole?: "USER" | "ADMIN";
      csrfToken?: string;
      apiKeyId?: string;
      apiKeyType?: "PUBLISHABLE" | "SECRET";
    }
  }
}

export {};
