import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";

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
