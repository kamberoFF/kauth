import { type Request, type RequestHandler } from "express";
import { API_KEY_HEADER, PROJECT_ID_HEADER } from "../constants/headers";
import { resolveApiKey } from "../lib/apiKeys";
import { resolveProjectIdOrThrow } from "../lib/projects";
import { appError } from "../utils/errors";
import type { ApiKey } from "../generated/prisma/client";

/**
 * Shared by requireApiKey and requireSecretKey: resolves the presented key or
 * throws the same 401s a missing/unknown/revoked key produces everywhere.
 * Never returns "revoked" or null — those become thrown errors here, so
 * callers only ever get back a live key row.
 */
async function authenticateApiKey(req: Request) {
  const raw = req.get(API_KEY_HEADER);

  if (!raw) {
    throw appError(401, "No API key provided", "api_key_missing");
  }

  const resolved = await resolveApiKey(raw);

  if (resolved === "revoked") {
    throw appError(401, "API key has been revoked", "api_key_revoked");
  }

  if (!resolved) {
    throw appError(401, "Invalid API key", "api_key_invalid");
  }

  return resolved;
}

function applyApiKey(req: Request, key: ApiKey) {
  req.projectId = key.project_id;
  req.apiKeyId = key.id;
  req.apiKeyType = key.key_type;
}

/**
 * Either tier — a key resolves to a project, never a user identity. This is
 * a parallel path to requireAuth/requireProject, not a variant of either.
 */
export const requireApiKey: RequestHandler = async (req, _res, next) => {
  try {
    applyApiKey(req, await authenticateApiKey(req));
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * The elevated-operations gate: a publishable key authenticates fine but is
 * rejected here, distinctly from an unknown/revoked key, so a client can tell
 * "wrong tier" from "wrong key" apart.
 */
export const requireSecretKey: RequestHandler = async (req, _res, next) => {
  try {
    const key = await authenticateApiKey(req);

    if (key.key_type !== "SECRET") {
      return next(
        appError(
          403,
          "This operation requires a secret key",
          "api_key_tier_forbidden",
        ),
      );
    }

    applyApiKey(req, key);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * register/login only: an API key, when presented, resolves the project and
 * is authoritative — the existing x-project-id header is the fallback for
 * clients not yet using a key, never cross-checked against one that is
 * present. Either key tier reaches signup/login, since elevated access is a
 * superset of publishable access.
 */
export const resolveProjectFromKeyOrHeader: RequestHandler = async (
  req,
  res,
  next,
) => {
  if (req.get(API_KEY_HEADER)) {
    return requireApiKey(req, res, next);
  }

  try {
    req.projectId = await resolveProjectIdOrThrow(
      req.get(PROJECT_ID_HEADER),
      `header: ${PROJECT_ID_HEADER}`,
    );
    next();
  } catch (error) {
    next(error);
  }
};
