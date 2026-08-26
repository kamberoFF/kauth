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
  backfillMfaGrace,
  resolveMfaGraceDays,
} from "../lib/mfaPolicy";
import {
  recordSecurityEvent,
  requestContext,
} from "../lib/securityEvents";

function serializeProject(project: {
  id: string;
  name: string;
  owner_id: string | null;
  min_password_length: number | null;
  enforce_mfa: boolean;
  mfa_grace_days: number | null;
  created_at: Date;
}) {
  return {
    id: project.id,
    name: project.name,
    ownerId: project.owner_id,
    minPasswordLength: project.min_password_length,
    enforceMfa: project.enforce_mfa,
    mfaGraceDays: project.mfa_grace_days,
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
 * Owner-only settings update. Partial-update semantics — an absent field is
 * left untouched, so setting the MFA mandate never has to re-state the
 * password floor. Reached through requireProjectOwnership, so req.projectId
 * is already validated as an owned UUID.
 */
export const updateProject: RequestHandler = async (req, res, next) => {
  try {
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const projectId = requireProjectId(req);
    const context = requestContext(req);

    // One transaction, so the audit rows, the policy change, and any grace
    // backfill commit or roll back together. Both policy events are recorded
    // only when a value actually flips: re-submitting the current settings is
    // not an auth-relevant transition, and noise-free audit beats noisy audit.
    const project = await prisma.$transaction(async (tx) => {
      const current = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
      });

      // Absent means "leave as is"; explicit null clears back to defaults.
      const minPasswordLength =
        parsed.data.min_password_length !== undefined
          ? parsed.data.min_password_length
          : current.min_password_length;
      const enforceMfa = parsed.data.enforce_mfa ?? current.enforce_mfa;
      const mfaGraceDays = parsed.data.mfa_grace_days !== undefined
        ? parsed.data.mfa_grace_days
        : current.mfa_grace_days;

      if (enforceMfa && !current.enforce_mfa) {
        // Activation backfills windows once, in this transaction, so nobody
        // already using the product is walled the moment the mandate lands.
        await backfillMfaGrace(
          tx,
          projectId,
          resolveMfaGraceDays({ mfa_grace_days: mfaGraceDays }),
        );
      }

      const updated = await tx.project.update({
        where: { id: projectId },
        data: {
          min_password_length: minPasswordLength,
          enforce_mfa: enforceMfa,
          mfa_grace_days: mfaGraceDays,
        },
      });

      if (
        parsed.data.min_password_length !== undefined &&
        parsed.data.min_password_length !== current.min_password_length
      ) {
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
      }

      if (
        (parsed.data.enforce_mfa !== undefined &&
          parsed.data.enforce_mfa !== current.enforce_mfa) ||
        (parsed.data.mfa_grace_days !== undefined &&
          parsed.data.mfa_grace_days !== current.mfa_grace_days)
      ) {
        await recordSecurityEvent(
          {
            type: "PROJECT_MFA_POLICY_CHANGED",
            projectId,
            userId: requireUserId(req),
            ...context,
            metadata: { enforce_mfa: enforceMfa, mfa_grace_days: mfaGraceDays },
          },
          tx,
        );
      }

      return updated;
    });

    res.json(serializeProject(project));
  } catch (error) {
    next(error);
  }
};
