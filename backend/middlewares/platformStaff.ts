import { type RequestHandler } from "express";
import { isPlatformProject } from "../lib/platformProject";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";

/**
 * Gates the platform-staff surface to `Role.ADMIN` users of the reserved
 * platform Project — the one role distinction with server-defined meaning
 * (clerk-clone ticket 03). Deliberately zero queries: requireAuth has just
 * read the user row and left the fresh role on req (ADR 0007), so a demoted
 * admin loses access on their very next request even while their old token
 * still carries an ADMIN claim.
 *
 * Session-only by construction: requireAuth runs first, and a request
 * bearing only an API key never gets this far.
 */
export const requirePlatformStaff: RequestHandler = (req, _res, next) => {
  try {
    const projectId = requireProjectId(req);
    requireUserId(req);

    if (!isPlatformProject(projectId) || req.userRole !== "ADMIN") {
      return next(appError(403, "Platform staff required", "staff_forbidden"));
    }

    next();
  } catch (error) {
    next(error);
  }
};
