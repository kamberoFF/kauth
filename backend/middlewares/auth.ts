import { type Request, type RequestHandler } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { readSessionCookie } from "../lib/tokenTransport";
import { appError } from "../utils/errors";

/**
 * A bearer header wins over the cookie. A client that sends both has made its
 * transport explicit, and silently preferring the ambient credential would make
 * the effective identity depend on cookie state the caller may not know about.
 */
function presentedToken(req: Request) {
  const [scheme, token] = req.headers.authorization?.split(" ") ?? [];

  if (scheme?.toLowerCase() === "bearer" && token) {
    return token;
  }

  return readSessionCookie(req);
}

/**
 * Verifying the signature is not enough: an access token stays cryptographically
 * valid for its full 15 minutes, including after logout, a password change, or
 * reuse detection. The session row is the authority on whether it still counts,
 * so every authenticated request pays one primary-key read for real revocation.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = presentedToken(req);

    if (!token) {
      return next(appError(401, "No token provided", "token_missing"));
    }

    const payload = verifyAccessToken(token);

    if (!payload) {
      return next(appError(401, "Invalid or expired token", "token_invalid"));
    }

    const session = await prisma.session.findUnique({
      where: { id: payload.sid },
      select: {
        id: true,
        user_id: true,
        project_id: true,
        status: true,
        expires_at: true,
      },
    });

    if (!session) {
      return next(appError(401, "Invalid or expired token", "token_invalid"));
    }

    // A validly signed token whose subject disagrees with its session is not an
    // ordinary expiry; it means a token was minted against someone else's row.
    if (session.user_id !== payload.userId) {
      return next(appError(401, "Invalid or expired token", "token_invalid"));
    }

    // Same failure class as the user-id check above: a token minted for one
    // project must never be honored against another project's session.
    if (session.project_id !== payload.projectId) {
      return next(appError(401, "Invalid or expired token", "token_invalid"));
    }

    if (session.status !== "ACTIVE") {
      return next(appError(401, "Session is no longer active", "session_revoked"));
    }

    if (session.expires_at <= new Date()) {
      return next(appError(401, "Session has expired", "session_expired"));
    }

    req.userId = session.user_id;
    req.sessionId = session.id;
    req.projectId = session.project_id;

    next();
  } catch (error) {
    // Express 4 does not forward a rejected promise from a middleware, so an
    // unhandled failure here would hang the request instead of returning 500.
    next(error);
  }
};
