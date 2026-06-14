// backend/types/express.d.ts
import "express";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      deviceId?: string;
      csrfToken?: string;
    }
  }
}

export {};
