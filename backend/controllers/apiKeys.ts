import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { issueApiKeySchema } from "../lib/validation";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";
import { UUID_REGEX } from "../constants/regex";
import { generatePublishableKey, generateSecretKey } from "../lib/apiKeys";
import { recordSecurityEvent, requestContext } from "../lib/securityEvents";

/**
 * The one place either key tier's raw value is ever returned: at creation.
 * A secret key's verifier is bcrypt-hashed the moment this response is sent
 * and is not reconstructable from the database afterward.
 */
export const issueApiKey: RequestHandler = async (req, res, next) => {
  try {
    const parsed = issueApiKeySchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const projectId = requireProjectId(req);
    const userId = requireUserId(req);
    const context = requestContext(req);

    const generated =
      parsed.data.type === "PUBLISHABLE"
        ? { ...generatePublishableKey(), hash: null as string | null }
        : await generateSecretKey();

    const key = await prisma.$transaction(async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          project_id: projectId,
          key_type: parsed.data.type,
          key_prefix: generated.prefix,
          key_value: parsed.data.type === "PUBLISHABLE" ? generated.raw : null,
          key_hash: generated.hash,
          created_by_user_id: userId,
        },
      });

      await recordSecurityEvent(
        {
          type: "API_KEY_ISSUED",
          userId,
          projectId,
          ...context,
          metadata: {
            apiKeyId: created.id,
            keyType: created.key_type,
            prefix: created.key_prefix,
          },
        },
        tx,
      );

      return created;
    });

    res.status(201).json({
      id: key.id,
      type: key.key_type,
      prefix: key.key_prefix,
      value: generated.raw,
      createdAt: key.created_at,
    });
  } catch (error) {
    next(error);
  }
};

export const listApiKeys: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);

    const keys = await prisma.apiKey.findMany({
      where: { project_id: projectId },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        key_type: true,
        key_prefix: true,
        created_at: true,
        last_used_at: true,
        revoked_at: true,
      },
    });

    res.json({
      keys: keys.map((key) => ({
        id: key.id,
        type: key.key_type,
        prefix: key.key_prefix,
        createdAt: key.created_at,
        lastUsedAt: key.last_used_at,
        revokedAt: key.revoked_at,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Publishable keys stay retrievable in full here at any time, since they're
 * meant to be public. Secret keys never appear again past issueApiKey's
 * response — `value` is always null for them, not merely omitted, so a
 * client can't mistake "not included" for "ask again".
 */
export const getApiKey: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);
    const keyId = req.params.keyId ?? "";

    if (!UUID_REGEX.test(keyId)) {
      return next(appError(400, "Invalid API key id", "api_key_id_invalid"));
    }

    const key = await prisma.apiKey.findFirst({
      where: { id: keyId, project_id: projectId },
    });

    if (!key) {
      return next(appError(404, "API key not found", "api_key_not_found"));
    }

    res.json({
      id: key.id,
      type: key.key_type,
      prefix: key.key_prefix,
      value: key.key_type === "PUBLISHABLE" ? key.key_value : null,
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at,
      revokedAt: key.revoked_at,
    });
  } catch (error) {
    next(error);
  }
};

export const revokeApiKey: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);
    const userId = requireUserId(req);
    const context = requestContext(req);
    const keyId = req.params.keyId ?? "";

    if (!UUID_REGEX.test(keyId)) {
      return next(appError(400, "Invalid API key id", "api_key_id_invalid"));
    }

    await prisma.$transaction(async (tx) => {
      // Not-found, belongs-to-another-project, and already-revoked all
      // collapse into the same where-clause, same idiom as revokeSession.
      const key = await tx.apiKey.findFirst({
        where: { id: keyId, project_id: projectId, revoked_at: null },
      });

      if (!key) {
        throw appError(404, "API key not found", "api_key_not_found");
      }

      await tx.apiKey.update({
        where: { id: key.id },
        data: { revoked_at: new Date() },
      });

      await recordSecurityEvent(
        {
          type: "API_KEY_REVOKED",
          userId,
          projectId,
          ...context,
          metadata: {
            apiKeyId: key.id,
            keyType: key.key_type,
            prefix: key.key_prefix,
          },
        },
        tx,
      );
    });

    res.json({ message: "API key revoked" });
  } catch (error) {
    next(error);
  }
};
