import { type RequestHandler } from "express";
import { PROJECT_ID_HEADER } from "../constants/headers";
import { resolveProjectIdOrThrow } from "../lib/projects";

/**
 * Unlike requireDevice, this hits the database: a project id is a real FK
 * target, not opaque client metadata, so a bogus id must fail as a clean 404
 * here rather than surface as an unhandled Postgres FK-violation 500 later.
 */
export const requireProject: RequestHandler = async (req, _res, next) => {
  try {
    req.projectId = await resolveProjectIdOrThrow(
      req.get(PROJECT_ID_HEADER),
      `header: ${PROJECT_ID_HEADER}`,
    );
    next();
  } catch (error) {
    // Express 4 does not forward a rejected promise from a middleware, so an
    // unhandled failure here would hang the request instead of returning 500.
    next(error);
  }
};
