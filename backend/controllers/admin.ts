import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { PLATFORM_PROJECT_ID } from "../constants/platform";
import { UUID_REGEX } from "../constants/regex";
import { roleChangeSchema } from "../lib/validation";
import { appError } from "../utils/errors";
import { requireUserId } from "../utils/requestGuards";
import { revokeSessions } from "../lib/sessions";
import { recordSecurityEvent, requestContext } from "../lib/securityEvents";
import { USER_LIST_SELECT, serializeUser } from "../lib/projectManagement";

/**
 * Platform-staff controllers (routes/admin.ts). Every query is deliberately
 * unscoped by project — seeing across tenants is the point of the surface,
 * which is exactly why it is session-only and staff-gated.
 */
export const listProjects: RequestHandler = async (_req, res, next) => {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { created_at: "asc" },
      select: {
        id: true,
        name: true,
        owner_id: true,
        created_at: true,
      },
    });

    res.json({
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        ownerId: project.owner_id,
        createdAt: project.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Shared guard for the surface's path parameters: a malformed UUID is a
 * malformed request (400), never a lookup miss (404) — the same split every
 * other parameter-validated route in kauth draws.
 */
function uuidParamOr400(
  value: string | undefined,
  field: "project" | "session" | "user",
): string {
  const id = value ?? "";

  if (!UUID_REGEX.test(id)) {
    throw appError(400, `Invalid ${field} id`, `${field}_id_invalid`);
  }

  return id;
}

export const listProjectUsers: RequestHandler = async (req, res, next) => {
  try {
    const projectId = uuidParamOr400(req.params.projectId, "project");

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });

    if (!project) {
      return next(appError(404, "Project not found", "project_not_found"));
    }

    const users = await prisma.user.findMany({
      where: { project_id: projectId },
      orderBy: { created_at: "asc" },
      select: USER_LIST_SELECT,
    });

    res.json({ users: users.map(serializeUser) });
  } catch (error) {
    next(error);
  }
};

async function findSessionOr404(sessionId: string) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId },
    select: {
      id: true,
      user_id: true,
      status: true,
      created_at: true,
      last_used_at: true,
      expires_at: true,
      revoked_at: true,
    },
  });

  if (!session) {
    throw appError(404, "Session not found", "session_not_found");
  }

  return session;
}

export const getSession: RequestHandler = async (req, res, next) => {
  try {
    const session = await findSessionOr404(
      uuidParamOr400(req.params.sessionId, "session"),
    );

    res.json({
      id: session.id,
      userId: session.user_id,
      status: session.status,
      createdAt: session.created_at,
      lastUsedAt: session.last_used_at,
      expiresAt: session.expires_at,
      revokedAt: session.revoked_at,
    });
  } catch (error) {
    next(error);
  }
};

export const revokeSession: RequestHandler = async (req, res, next) => {
  try {
    const sessionId = uuidParamOr400(req.params.sessionId, "session");
    // Scoped by nothing but existence, deliberately: cross-project reach is
    // the staff surface's whole point, unlike the secret-key route this
    // shadows. Active-only so a revoke of a dead session stays a clean 404.
    const session = await prisma.session.findFirst({
      where: { id: sessionId, status: "ACTIVE" },
      select: { id: true, user_id: true, project_id: true },
    });

    if (!session) {
      return next(appError(404, "Session not found", "session_not_found"));
    }

    const actorUserId = requireUserId(req);

    await prisma.$transaction(async (tx) => {
      await revokeSessions(tx, { id: session.id }, "staff_revoked");

      await recordSecurityEvent(
        {
          type: "SESSION_REVOKED",
          userId: session.user_id,
          sessionId: session.id,
          projectId: session.project_id,
          ...requestContext(req),
          metadata: { actor_user_id: actorUserId },
        },
        tx,
      );
    });

    res.json({ message: "Session revoked" });
  } catch (error) {
    next(error);
  }
};

export const setUserRole: RequestHandler = async (req, res, next) => {
  try {
    const parsed = roleChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(appError(400, "Invalid input", "validation"));
    }

    const targetUserId = uuidParamOr400(req.params.userId, "user");

    // Role changes are platform-staff business only (ADR 0007): a tenant
    // Project's end-user roles belong to whoever asks for that feature, and
    // until then an exists-but-tenant target collapses into the same 404 as
    // a nonexistent one.
    const target = await prisma.user.findFirst({
      where: { id: targetUserId, project_id: PLATFORM_PROJECT_ID },
      select: { id: true, role: true },
    });

    if (!target) {
      return next(appError(404, "User not found", "user_not_found"));
    }

    const actorUserId = requireUserId(req);

    // A lone staff member demoting themselves has no one left to undo it;
    // recovery runs through scripts/promote-staff.ts instead of a special
    // case here.
    if (targetUserId === actorUserId) {
      return next(
        appError(
          403,
          "Staff cannot change their own role",
          "self_role_change",
        ),
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: { role: parsed.data.role },
      });

      await recordSecurityEvent(
        {
          type: "ROLE_CHANGED",
          userId: target.id,
          projectId: PLATFORM_PROJECT_ID,
          ...requestContext(req),
          metadata: {
            old_role: target.role,
            new_role: parsed.data.role,
            actor_user_id: actorUserId,
          },
        },
        tx,
      );
    });

    res.json({ message: "Role updated", role: parsed.data.role });
  } catch (error) {
    next(error);
  }
};
