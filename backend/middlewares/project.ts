import { type RequestHandler } from "express";
import { UUID_REGEX } from "../constants/regex";
import { PROJECT_ID_HEADER } from "../constants/headers";
import { resolveProject } from "../lib/projects";
import { appError } from "../utils/errors";

/**
 * Unlike requireDevice, this hits the database: a project id is a real FK
 * target, not opaque client metadata, so a bogus id must fail as a clean 404
 * here rather than surface as an unhandled Postgres FK-violation 500 later.
 */
export const requireProject: RequestHandler = async (req, _res, next) => {
  try {
    const projectId = req.get(PROJECT_ID_HEADER)?.trim();

    if (!projectId) {
      return next(
        appError(
          400,
          `Missing required header: ${PROJECT_ID_HEADER}`,
          "project_id_missing",
        ),
      );
    }

    if (!UUID_REGEX.test(projectId)) {
      return next(
        appError(
          400,
          `Invalid ${PROJECT_ID_HEADER} format. Must be a valid UUID v4`,
          "project_id_invalid",
        ),
      );
    }

    const project = await resolveProject(projectId);

    if (!project) {
      return next(appError(404, "Project not found", "project_not_found"));
    }

    req.projectId = project.id;
    next();
  } catch (error) {
    // Express 4 does not forward a rejected promise from a middleware, so an
    // unhandled failure here would hang the request instead of returning 500.
    next(error);
  }
};
