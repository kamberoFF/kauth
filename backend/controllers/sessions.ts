import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";
import { UUID_REGEX } from "../constants/regex";
import { revokeSessions } from "../lib/sessions";
import { clearAuthCookies } from "../lib/tokenTransport";
import { recordSessionRevoked, requestContext } from "../lib/securityEvents";

export const listSessions: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = requireProjectId(req);

    const sessions = await prisma.session.findMany({
      where: { user_id: userId, project_id: projectId, status: "ACTIVE" },
      orderBy: [{ last_used_at: "desc" }, { created_at: "desc" }],
      select: {
        id: true,
        device_id: true,
        device_name: true,
        device_type: true,
        os_name: true,
        os_version: true,
        browser_name: true,
        browser_version: true,
        ip_created: true,
        ip_last: true,
        country_created: true,
        country_last: true,
        city_created: true,
        city_last: true,
        user_agent_created: true,
        user_agent_last: true,
        created_at: true,
        last_used_at: true,
        expires_at: true,
      },
    });

    res.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        current: session.id === req.sessionId,
        deviceId: session.device_id,
        deviceName: session.device_name,
        deviceType: session.device_type,
        osName: session.os_name,
        osVersion: session.os_version,
        browserName: session.browser_name,
        browserVersion: session.browser_version,
        ipCreated: session.ip_created,
        ipLast: session.ip_last,
        countryCreated: session.country_created,
        countryLast: session.country_last,
        cityCreated: session.city_created,
        cityLast: session.city_last,
        userAgentCreated: session.user_agent_created,
        userAgentLast: session.user_agent_last,
        createdAt: session.created_at,
        lastUsedAt: session.last_used_at,
        expiresAt: session.expires_at,
      })),
    });
  } catch (error) {
    next(error);
  }
};

export const revokeSession: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = requireProjectId(req);
    const context = requestContext(req);
    const sessionId = req.params.sessionId ?? "";

    if (!UUID_REGEX.test(sessionId)) {
      return next(appError(400, "Invalid session id", "session_id_invalid"));
    }

    const revokedIds = await prisma.$transaction(async (tx) => {
      // The ownership check lives in this where-clause on purpose: a session
      // that doesn't exist, belongs to another user, belongs to another
      // project, or is already revoked all collapse into the same empty
      // result, so none of those cases can be told apart from the outside.
      const ids = await revokeSessions(
        tx,
        { id: sessionId, user_id: userId, project_id: projectId },
        "user_revoked",
      );

      if (ids.length === 0) {
        throw appError(404, "Session not found", "session_not_found");
      }

      await recordSessionRevoked(tx, {
        userId,
        sessionId: ids[0]!,
        projectId,
        actor: { actor: "self" },
        context,
      });

      return ids;
    });

    // Symmetric with logout: a caller who revokes their own current session
    // should not be left holding a cookie for a session that no longer exists.
    if (revokedIds[0] === req.sessionId) {
      clearAuthCookies(res);
    }

    res.json({ message: "Session revoked" });
  } catch (error) {
    next(error);
  }
};
