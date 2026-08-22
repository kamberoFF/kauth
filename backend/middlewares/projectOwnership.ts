import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { UUID_REGEX } from "../constants/regex";
import { appError } from "../utils/errors";
import { requireUserId } from "../utils/requestGuards";

/**
 * Gates project-management routes (key issuance/revocation today; rename,
 * delete, and other project-management actions later) to the authenticated
 * developer who owns the project — never a request bearing an API key, since
 * requireAuth already rejected any request with no session before this runs.
 * A project that doesn't exist and one that exists but isn't the caller's
 * collapse into the same 404, the same idiom revokeSession/unlinkAccount use.
 */
export const requireProjectOwnership: RequestHandler = async (
  req,
  _res,
  next,
) => {
  try {
    const userId = requireUserId(req);
    const projectId = req.params.projectId ?? "";

    if (!UUID_REGEX.test(projectId)) {
      return next(appError(400, "Invalid project id", "project_id_invalid"));
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, owner_id: userId },
      select: { id: true },
    });

    if (!project) {
      return next(appError(404, "Project not found", "project_not_found"));
    }

    req.projectId = project.id;
    next();
  } catch (error) {
    next(error);
  }
};
