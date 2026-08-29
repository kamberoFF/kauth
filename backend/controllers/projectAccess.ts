import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { appError } from "../utils/errors";
import { requireProjectId } from "../utils/requestGuards";
import { UUID_REGEX } from "../constants/regex";
import { revokeSessions } from "../lib/sessions";
import { recordSecurityEvent, requestContext } from "../lib/securityEvents";
import { USER_LIST_SELECT, serializeUser } from "../lib/projectManagement";

/**
 * Secret-key-scoped endpoints: the key resolves the project, never a user
 * identity, so every query here is scoped by req.projectId alone — there is
 * no req.userId to additionally check against.
 */
export const listProjectUsers: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);

    const users = await prisma.user.findMany({
      where: { project_id: projectId },
      orderBy: { created_at: "asc" },
      select: USER_LIST_SELECT,
    });

    res.json({ users: users.map(serializeUser) });
  } catch (error) {
    next(error);
  }
};

export const verifyProjectSession: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);
    const sessionId = req.params.sessionId ?? "";

    if (!UUID_REGEX.test(sessionId)) {
      return next(appError(400, "Invalid session id", "session_id_invalid"));
    }

    const session = await prisma.session.findFirst({
      where: { id: sessionId, project_id: projectId },
      select: {
        id: true,
        user_id: true,
        status: true,
        created_at: true,
        last_used_at: true,
        expires_at: true,
        revoked_at: true,
      },
    });

    if (!session) {
      return next(appError(404, "Session not found", "session_not_found"));
    }

    res.json({
      id: session.id,
      userId: session.user_id,
      status: session.status,
      createdAt: session.created_at,
      lastUsedAt: session.last_used_at,
      expiresAt: session.expires_at,
      revokedAt: session.revoked_at,
    });
  } catch (error) {
    next(error);
  }
};

export const revokeProjectSession: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);
    const context = requestContext(req);
    const sessionId = req.params.sessionId ?? "";

    if (!UUID_REGEX.test(sessionId)) {
      return next(appError(400, "Invalid session id", "session_id_invalid"));
    }

    await prisma.$transaction(async (tx) => {
      // Scoped by project only, deliberately no user_id filter: a secret key
      // may revoke any end user's session in its own project, unlike the
      // self-service /sessions/:sessionId route this is not a variant of.
      const session = await tx.session.findFirst({
        where: { id: sessionId, project_id: projectId, status: "ACTIVE" },
        select: { id: true, user_id: true },
      });

      if (!session) {
        throw appError(404, "Session not found", "session_not_found");
      }

      await revokeSessions(
        tx,
        { id: sessionId, project_id: projectId },
        "api_key_revoked",
      );

      await recordSecurityEvent(
        {
          type: "SESSION_REVOKED",
          userId: session.user_id,
          sessionId: session.id,
          projectId,
          ...context,
          metadata: { apiKeyId: req.apiKeyId },
        },
        tx,
      );
    });

    res.json({ message: "Session revoked" });
  } catch (error) {
    next(error);
  }
};
