import { prisma } from "./prisma";

/**
 * Existence check for a client-supplied project id. Shared by requireProject
 * (header path) and the OAuth query-param path, so both fail the same way on
 * an id that doesn't resolve to a real project.
 */
export async function resolveProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    select: { id: true },
  });
}
