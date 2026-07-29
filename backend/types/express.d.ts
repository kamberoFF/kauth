// backend/types/express.d.ts
import "express";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
      deviceId?: string;
      csrfToken?: string;
    }
  }
}

export {};
