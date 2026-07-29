import { type Request, type Response, type RequestHandler } from "express";
import { generateCodeVerifier, generateState, type OAuth2Tokens } from "arctic";
import config from "../config";
import { prisma } from "../lib/prisma";
import { appError } from "../utils/errors";
import { requireDeviceId } from "../utils/requestGuards";
import { oauthCookieOptions } from "../config/cookies";
import {
  getOAuthProvider,
  enabledProviders,
  type OAuthProfile,
  type OAuthProvider,
} from "../lib/oauth/providers";
import {
  consumeRecoveryToken,
  issueRecoveryToken,
} from "../lib/recoveryTokens";
import { clientContext, createSession, revokeSessions } from "../lib/sessions";
import {
  recordSecurityEvent,
  requestContext,
  tryRecordSecurityEvent,
} from "../lib/securityEvents";
import { oauthExchangeSchema } from "../lib/validation";
import { sendAuthResponse } from "../lib/tokenTransport";

const STATE_COOKIE = "kauth_oauth_state";
const VERIFIER_COOKIE = "kauth_oauth_verifier";

function frontendCallback(params: Record<string, string>) {
  const url = new URL("/oauth/callback", config.frontend_url);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function splitName(name: string | null) {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];

  return {
    first_name: parts[0] ?? null,
    last_name: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

function oauthTokenFields(tokens: OAuth2Tokens) {
  return {
    access_token: tokens.accessToken(),
    refresh_token: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
    scope: tokens.hasScopes() ? tokens.scopes().join(" ") : null,
  };
}

export const listProviders: RequestHandler = (_req, res) => {
  res.json({ providers: enabledProviders() });
};

export const startOAuth: RequestHandler = (req, res, next) => {
  try {
    const provider = getOAuthProvider(req.params.provider ?? "");

    if (!provider) {
      return next(appError(404, "Unknown provider", "provider_not_found"));
    }

    const state = generateState();
    const codeVerifier = generateCodeVerifier();

    res.cookie(STATE_COOKIE, state, oauthCookieOptions);

    if (provider.usesPkce) {
      res.cookie(VERIFIER_COOKIE, codeVerifier, oauthCookieOptions);
    }

    res.redirect(
      provider.createAuthorizationURL(state, codeVerifier).toString(),
    );
  } catch (error) {
    next(error);
  }
};

/**
 * Finds the user this provider identity belongs to, creating or linking one as
 * needed. Linking to an existing account requires the provider to vouch for the
 * email: without that check, anyone who can set an unverified address at a
 * provider could take over the matching kauth account.
 */
async function resolveUser(
  provider: OAuthProvider,
  profile: OAuthProfile,
  tokens: OAuth2Tokens,
  context: { ip: string | null; userAgent: string | null },
) {
  const linked = await prisma.account.findUnique({
    where: {
      provider_id_account_id: {
        provider_id: provider.id,
        account_id: profile.accountId,
      },
    },
    include: { user: true },
  });

  if (linked) {
    await prisma.account.update({
      where: { id: linked.id },
      data: oauthTokenFields(tokens),
    });

    return linked.user;
  }

  if (!profile.email) {
    throw appError(
      400,
      "The provider did not supply an email address",
      "oauth_no_email",
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email: profile.email },
  });

  if (existing) {
    if (!profile.emailVerified) {
      throw appError(
        409,
        "An account with this email already exists. Sign in and link the provider instead.",
        "oauth_email_unverified",
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.account.create({
        data: {
          user_id: existing.id,
          provider_id: provider.id,
          account_id: profile.accountId,
          ...oauthTokenFields(tokens),
        },
      });

      await recordSecurityEvent(
        {
          type: "OAUTH_ACCOUNT_LINKED",
          userId: existing.id,
          ...context,
          metadata: { provider: provider.id },
        },
        tx,
      );
    });

    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: profile.email!,
        email_verified: profile.emailVerified,
        image: profile.image,
        ...splitName(profile.name),
      },
    });

    await tx.account.create({
      data: {
        user_id: created.id,
        provider_id: provider.id,
        account_id: profile.accountId,
        ...oauthTokenFields(tokens),
      },
    });

    await recordSecurityEvent(
      {
        type: "USER_REGISTERED",
        userId: created.id,
        ...context,
        metadata: { provider: provider.id },
      },
      tx,
    );

    return created;
  });
}

function readAndClearCookie(req: Request, res: Response, name: string) {
  const value = (req.cookies as Record<string, string> | undefined)?.[name];

  // maxAge is deliberately dropped: clearCookie expires the cookie itself, and
  // Express warns when it is passed one.
  const { maxAge: _maxAge, ...clearOptions } = oauthCookieOptions;
  res.clearCookie(name, clearOptions);

  return value;
}

export const oauthCallback: RequestHandler = async (req, res, next) => {
  const context = requestContext(req);
  const providerId = req.params.provider ?? "";
  const provider = getOAuthProvider(providerId);

  const state = readAndClearCookie(req, res, STATE_COOKIE);
  const codeVerifier = readAndClearCookie(req, res, VERIFIER_COOKIE);

  async function fail(reason: string) {
    await tryRecordSecurityEvent({
      type: "OAUTH_LOGIN_FAILED",
      ...context,
      metadata: { provider: providerId, reason },
    });

    res.redirect(frontendCallback({ error: reason }));
  }

  try {
    if (!provider) {
      return next(appError(404, "Unknown provider", "provider_not_found"));
    }

    if (typeof req.query.error === "string") {
      return await fail(req.query.error);
    }

    const code = req.query.code;
    const returnedState = req.query.state;

    if (typeof code !== "string" || typeof returnedState !== "string") {
      return await fail("invalid_response");
    }

    // The state cookie is what ties this callback to a flow this browser
    // actually started, which is the CSRF defense for the redirect itself.
    if (!state || returnedState !== state) {
      return await fail("state_mismatch");
    }

    if (provider.usesPkce && !codeVerifier) {
      return await fail("missing_code_verifier");
    }

    const tokens = await provider.validateAuthorizationCode(
      code,
      codeVerifier ?? "",
    );
    const profile = await provider.fetchProfile(tokens);
    const user = await resolveUser(provider, profile, tokens, context);

    await tryRecordSecurityEvent({
      type: "OAUTH_LOGIN_SUCCESS",
      userId: user.id,
      ...context,
      metadata: { provider: provider.id },
    });

    // The browser cannot supply a device id on a redirect, and putting session
    // tokens in a URL would leak them into history and referrers. The frontend
    // trades this short-lived code for a real token pair instead.
    const exchangeCode = await issueRecoveryToken(user.id, "OAUTH_EXCHANGE");

    res.redirect(frontendCallback({ code: exchangeCode }));
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) {
      return await fail(String((error as { code?: string }).code ?? "oauth_failed"));
    }

    console.error(`[oauth] ${providerId} callback failed`, error);
    await fail("oauth_failed");
  }
};

export const exchangeOAuthCode: RequestHandler = async (req, res, next) => {
  try {
    const parsed = oauthExchangeSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const context = clientContext(req, requireDeviceId(req));
    const record = await consumeRecoveryToken(parsed.data.code, "OAUTH_EXCHANGE");

    if (!record) {
      return next(appError(400, "Invalid or expired code", "token_invalid"));
    }

    const result = await prisma.$transaction(async (tx) => {
      await revokeSessions(
        tx,
        { user_id: record.user_id, device_id: context.deviceId },
        "replaced_by_new_login",
      );

      const created = await createSession(tx, record.user_id, context);

      await recordSecurityEvent(
        {
          type: "LOGIN_SUCCESS",
          userId: record.user_id,
          sessionId: created.session.id,
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { provider: "oauth_exchange" },
        },
        tx,
      );

      return created;
    });

    sendAuthResponse(
      req,
      res,
      {
        accessToken: result.accessToken.token,
        refreshToken: result.refreshToken.token,
      },
      {},
    );
  } catch (error) {
    next(error);
  }
};
