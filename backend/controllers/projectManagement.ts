import { type RequestHandler } from "express";
import { requireProjectId } from "../utils/requestGuards";
import { listProjectEvents } from "../lib/projectManagement";

/**
 * Shared by the owner surface (`requireAuth` + `requireProjectOwnership`) and
 * the secret-key surface (`requireSecretKey`). Both middlewares set
 * `req.projectId` before this runs — the owner's from an owned `:projectId`
 * param, the key's from the key row — so from here down the two paths are
 * identical, scoped by `req.projectId` alone.
 */
export const listProjectEventsHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    const projectId = requireProjectId(req);

    res.json(await listProjectEvents(projectId, { ...req.query }));
  } catch (error) {
    next(error);
  }
};
