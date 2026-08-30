import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { projectOAuthCredentialSchema } from "../lib/validation";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";
import { recordSecurityEvent, requestContext } from "../lib/securityEvents";
import { encrypt } from "../lib/cryptoBox";
import {
  PROJECT_OAUTH_CONTEXT,
  describeProjectProvider,
  hasOAuthProviderFactory,
  oauthProviderFactoryIds,
} from "../lib/oauth/providers";

export const listProjectOAuthProviders: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);

    const rows = await prisma.projectOAuthCredential.findMany({
      where: { project_id: projectId },
      select: {
        provider_id: true,
        client_id: true,
        mode: true,
        client_secret_enc: true,
      },
    });
    const byProvider = new Map(rows.map((row) => [row.provider_id, row]));

    const providers = oauthProviderFactoryIds()
      .sort((a, b) => a.localeCompare(b))
      .map((id) => describeProjectProvider(id, byProvider.get(id)));

    res.json({ providers });
  } catch (error) {
    next(error);
  }
};

export const putProjectOAuthProvider: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);
    const userId = requireUserId(req);
    const context = requestContext(req);
    const providerId = req.params.provider ?? "";

    // An id kauth ships no client for cannot be a Project override — that stays
    // an instance-level, code-deployed concern (ADR 0009).
    if (!hasOAuthProviderFactory(providerId)) {
      return next(appError(400, "Unknown provider", "provider_not_found"));
    }

    const parsed = projectOAuthCredentialSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(appError(400, "Invalid input", "validation"));
    }

    const data =
      "disabled" in parsed.data
        ? { mode: "DISABLED" as const, client_id: "", client_secret_enc: null }
        : {
            mode: "OVERRIDE" as const,
            client_id: parsed.data.clientId,
            client_secret_enc: encrypt(
              parsed.data.clientSecret,
              PROJECT_OAUTH_CONTEXT,
            ),
          };

    // The row write and its audit event commit or roll back together, same as
    // updateProject's policy changes.
    const row = await prisma.$transaction(async (tx) => {
      const upserted = await tx.projectOAuthCredential.upsert({
        where: {
          project_id_provider_id: {
            project_id: projectId,
            provider_id: providerId,
          },
        },
        create: { project_id: projectId, provider_id: providerId, ...data },
        update: data,
      });

      await recordSecurityEvent(
        {
          type: "PROJECT_OAUTH_CONFIG_CHANGED",
          userId,
          projectId,
          ...context,
          metadata: {
            provider: providerId,
            action: data.mode === "DISABLED" ? "disabled" : "configured",
          },
        },
        tx,
      );

      return upserted;
    });

    res.json(describeProjectProvider(providerId, row));
  } catch (error) {
    next(error);
  }
};

export const deleteProjectOAuthProvider: RequestHandler = async (req, res, next) => {
  try {
    const projectId = requireProjectId(req);
    const userId = requireUserId(req);
    const context = requestContext(req);
    const providerId = req.params.provider ?? "";

    await prisma.$transaction(async (tx) => {
      // Not-configured and unknown-provider collapse into the same 404, the
      // revokeApiKey idiom — there is simply no override to clear. deleteMany
      // keeps it to one filtered write and stays correct under a concurrent
      // double-DELETE (the second sees count 0, not a P2025).
      const { count } = await tx.projectOAuthCredential.deleteMany({
        where: { project_id: projectId, provider_id: providerId },
      });

      if (count === 0) {
        throw appError(
          404,
          "No Provider app configured",
          "provider_not_configured",
        );
      }

      await recordSecurityEvent(
        {
          type: "PROJECT_OAUTH_CONFIG_CHANGED",
          userId,
          projectId,
          ...context,
          metadata: { provider: providerId, action: "cleared" },
        },
        tx,
      );
    });

    res.json({ message: "Provider app cleared" });
  } catch (error) {
    next(error);
  }
};
