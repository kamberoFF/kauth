import { type RequestHandler } from "express";
import { appError } from "../utils/errors";
import { requireApiKeyId, requireProjectId } from "../utils/requestGuards";
import { UUID_REGEX } from "../constants/regex";
import { requestContext } from "../lib/securityEvents";
import {
  getProjectSession,
  listProjectUsers as listUsersInProject,
  revokeProjectSession as revokeSessionInProject,
} from "../lib/projectManagement";

/**
 * Secret-key-scoped endpoints: the key resolves the project, never a user
 * identity, so every query here is scoped by req.projectId alone — there is
 * no req.userId to additionally check against.
 */
export const listProjectUsers: RequestHandler = async (req, res, next) => {
  try {
    res.json(await listUsersInProject(requireProjectId(req)));
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

    const session = await getProjectSession(projectId, sessionId);

    if (!session) {
      return next(appError(404, "Session not found", "session_not_found"));
    }

    res.json(session);
  } catch (error) {
    next(error);
  }
};

export const revokeProjectSession: RequestHandler = async (req, res, next) => {
  try {
    const sessionId = req.params.sessionId ?? "";

    if (!UUID_REGEX.test(sessionId)) {
      return next(appError(400, "Invalid session id", "session_id_invalid"));
    }

    await revokeSessionInProject(
      requireProjectId(req),
      sessionId,
      { actor: "api_key", api_key_id: requireApiKeyId(req) },
      requestContext(req),
    );

    res.json({ message: "Session revoked" });
  } catch (error) {
    next(error);
  }
};
