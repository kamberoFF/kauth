import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import {
  createProjectSchema,
  updateProjectSchema,
} from "../lib/validation";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";
import { isPlatformProject } from "../lib/platformProject";
import {
  recordSecurityEvent,
  requestContext,
} from "../lib/securityEvents";

function serializeProject(project: {
  id: string;
  name: string;
  owner_id: string | null;
  min_password_length: number | null;
  created_at: Date;
}) {
  return {
    id: project.id,
    name: project.name,
    ownerId: project.owner_id,
    minPasswordLength: project.min_password_length,
    createdAt: project.created_at,
  };
}

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
      data: {
        name: parsed.data.name,
        min_password_length: parsed.data.min_password_length ?? null,
        owner_id: userId,
      },
    });

    res.status(201).json(serializeProject(project));
  } catch (error) {
    next(error);
  }
};

/**
 * Owner-only settings update. Deliberately narrow — only the password policy
 * field is mutable until a second setting earns its way in (trusted_origins
 * wiring will likely be next). Reached through requireProjectOwnership, so
 * req.projectId is already validated as an owned UUID.
 */
export const updateProject: RequestHandler = async (req, res, next) => {
  try {
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const projectId = requireProjectId(req);
    const context = requestContext(req);

    // One transaction, so the audit row and the policy change commit or roll
    // back together. Lowering a Project's floor is an auth-relevant
    // transition — it weakens every credential set afterwards.
    const project = await prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id: projectId },
        data: { min_password_length: parsed.data.min_password_length },
      });

      await recordSecurityEvent(
        {
          type: "PROJECT_PASSWORD_POLICY_CHANGED",
          projectId,
          userId: requireUserId(req),
          ...context,
          metadata: { min_password_length: parsed.data.min_password_length },
        },
        tx,
      );

      return updated;
    });

    res.json(serializeProject(project));
  } catch (error) {
    next(error);
  }
};
