import { prisma } from "./prisma";
import { appError } from "../utils/errors";
import { UUID_REGEX } from "../constants/regex";

/**
 * Bare existence check for an already-validated project id. Not exported —
 * resolveProjectIdOrThrow below is what request handlers call; it wraps this
 * with the trim/format validation every client-supplied candidate needs
 * first, so calling this directly would skip that.
 */
async function resolveProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    select: { id: true },
  });
}

/**
 * Full validation for a client-supplied project id candidate — trim,
 * presence, UUID format, then existence — shared by requireProject (header),
 * startOAuth (query param), and oauthCallback (cookie) so none of the three
 * entry points can drift, as header vs. query param already had (one trimmed
 * the candidate before validating, the other didn't). `source` only shapes
 * the message text (e.g. "header: x-project-id"), never the error code, so
 * each entry point's failure still names where its own candidate came from.
 */
export async function resolveProjectIdOrThrow(
  candidate: string | undefined | null,
  source = "project id",
) {
  const projectId = candidate?.trim();

  if (!projectId) {
    throw appError(400, `Missing required ${source}`, "project_id_missing");
  }

  if (!UUID_REGEX.test(projectId)) {
    throw appError(
      400,
      `Invalid ${source} format. Must be a valid UUID v4`,
      "project_id_invalid",
    );
  }

  const project = await resolveProject(projectId);

  if (!project) {
    throw appError(404, "Project not found", "project_not_found");
  }

  return project.id;
}
