import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { createProjectSchema } from "../lib/validation";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";
import { isPlatformProject } from "../lib/platformProject";

/**
 * The owner is always the caller, never a client-supplied id — the same
 * self-service pattern every other endpoint here uses (changePassword,
 * unlinkAccount). That also is what makes this the whole check: a Project
 * can only ever be created owned by a user of the reserved platform
 * Project, because the caller's own session project is the only project
 * being scoped against.
 */
export const createProject: RequestHandler = async (req, res, next) => {
  try {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const projectId = requireProjectId(req);
    const userId = requireUserId(req);

    if (!isPlatformProject(projectId)) {
      return next(
        appError(
          403,
          "Only platform developers can create projects",
          "not_platform_developer",
        ),
      );
    }

    const project = await prisma.project.create({
      data: { name: parsed.data.name, owner_id: userId },
    });

    res.status(201).json({
      id: project.id,
      name: project.name,
      ownerId: project.owner_id,
      createdAt: project.created_at,
    });
  } catch (error) {
    next(error);
  }
};
