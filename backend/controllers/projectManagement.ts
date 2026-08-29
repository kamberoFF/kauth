import { type RequestHandler } from "express";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";
import { UUID_REGEX } from "../constants/regex";
import { requestContext } from "../lib/securityEvents";
import {
  getProjectSession,
  listProjectEvents,
  listProjectSessions,
  listProjectUsers,
  revokeProjectSession,
} from "../lib/projectManagement";

/**
 * The Project-scoped management surface, shared by two callers that differ
 * only in how `req.projectId` was resolved: the owner's session
 * (`requireAuth` + `requireProjectOwnership`, an owned `:projectId`) and a
 * secret API key (`requireSecretKey`, the key's own Project). From here down
 * every query is scoped by `req.projectId` alone.
 */

export const listProjectEventsHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    res.json(await listProjectEvents(requireProjectId(req), { ...req.query }));
  } catch (error) {
    next(error);
  }
};

export const listProjectSessionsHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    res.json(await listProjectSessions(requireProjectId(req), { ...req.query }));
  } catch (error) {
    next(error);
  }
};

export const listProjectUsersHandler: RequestHandler = async (req, res, next) => {
  try {
    res.json(await listProjectUsers(requireProjectId(req)));
  } catch (error) {
    next(error);
  }
};

/**
 * Owner surface only — a single session in the owner's Project. The secret-key
 * surface keeps its own `verifyProjectSession` handler for trail continuity,
 * but both now share the `getProjectSession` query.
 */
export const getProjectSessionHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    const projectId = requireProjectId(req);
    const sessionId = req.params.sessionId ?? "";

    if (!UUID_REGEX.test(sessionId)) {
      return next(appError(400, "Invalid session id", "session_id_invalid"));
    }

    const session = await getProjectSession(projectId, sessionId);

    if (!session) {
      return next(appError(404, "Session not found", "session_not_found"));
    }

    res.json(session);
  } catch (error) {
    next(error);
  }
};

/**
 * Owner surface — revoke any `ACTIVE` session in the owner's Project. The
 * `SESSION_REVOKED` event is attributed to the owner as the actor.
 */
export const revokeProjectSessionHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    const projectId = requireProjectId(req);
    const ownerUserId = requireUserId(req);
    const sessionId = req.params.sessionId ?? "";

    if (!UUID_REGEX.test(sessionId)) {
      return next(appError(400, "Invalid session id", "session_id_invalid"));
    }

    await revokeProjectSession(
      projectId,
      sessionId,
      { actor: "owner", actor_user_id: ownerUserId },
      requestContext(req),
    );

    res.json({ message: "Session revoked" });
  } catch (error) {
    next(error);
  }
};
