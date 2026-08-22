import { prisma } from "./prisma";
import { PLATFORM_PROJECT_ID, PLATFORM_PROJECT_NAME } from "../constants/platform";

/**
 * Idempotent: safe to call on every server boot, and explicitly wherever a
 * test needs the reserved project — `resetDatabase()` truncates `projects`
 * (and therefore this row) before every test, so there is no one-time
 * migration seed that would survive that.
 */
export async function ensurePlatformProject() {
  return prisma.project.upsert({
    where: { id: PLATFORM_PROJECT_ID },
    update: {},
    create: { id: PLATFORM_PROJECT_ID, name: PLATFORM_PROJECT_NAME },
  });
}

export function isPlatformProject(projectId: string) {
  return projectId === PLATFORM_PROJECT_ID;
}
