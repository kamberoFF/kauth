import crypto from "node:crypto";
import { type RequestHandler } from "express";
import bcrypt from "bcrypt";
import { generateTokens, parseRefreshToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
} from "../lib/validation";
import { appError } from "../utils/errors";
import {
  requireDeviceId,
  requireProjectId,
  requireUserId,
} from "../utils/requestGuards";
import { CREDENTIAL_PROVIDER } from "../constants/providers";
import config from "../config";
import { MFA_CHALLENGE_TTL_SECONDS, issueRecoveryToken } from "../lib/recoveryTokens";
import { existingAccountEmail, sendMail, verificationEmail } from "../lib/mail";
import {
  clientContext,
  createSession,
  isInactive,
  revokeRefreshFamily,
  revokeSessions,
  SESSION_TTL_MS,
} from "../lib/sessions";
import {
  hashPassword,
  projectPasswordFloor,
  verifyPassword,
} from "../lib/passwords";
import {
  recordSecurityEvent,
  requestContext,
  tryRecordSecurityEvent,
} from "../lib/securityEvents";
import { stampMfaGrace } from "../lib/mfaPolicy";
import {
  clearAuthCookies,
  readRefreshCookie,
  sendAuthResponse,
} from "../lib/tokenTransport";

const REFRESH_HASH_ROUNDS = 10;
export const register: RequestHandler = async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const { email, username, password, first_name, last_name } = parsed.data;
    const projectId = requireProjectId(req);
    // No device resolution here (ADR 0008): register creates no session, so
    // there is nothing to bind a device to. Event attribution comes straight
    // from the request.
    const { ip, userAgent } = requestContext(req);

    // The floor is per-Project policy, resolved here where the Project is
    // known — the schema only validates shape (see lib/validation.ts). Stays
    // ahead of any uniqueness lookup so the password rule never depends on
    // whether the account exists.
    if (password.length < (await projectPasswordFloor(projectId))) {
      return next(appError(400, "Password too short", "password_too_short"));
    }

    const [existingEmail, existingUsername] = await Promise.all([
      prisma.user.findUnique({
        where: { project_id_email: { project_id: projectId, email } },
        select: { id: true },
      }),
      prisma.user.findUnique({
        where: { project_id_username: { project_id: projectId, username } },
        select: { id: true },
      }),
    ]);

    // Usernames are user-chosen public handles — a collision discloses nothing
    // about anyone's email — so this stays a specific 409, and it is returned
    // before any email handling: a request colliding on both gets this.
    if (existingUsername)
      return next(appError(409, "Username is taken", "duplicate_username"));

    // Hashed unconditionally from here: both branches below must pay exactly
    // one Argon2id hash so response timing cannot separate a fresh email from
    // one that already has an account. The duplicate branch discards the
    // result on purpose — do not optimise it away.
    const passwordHash = await hashPassword(password);

    if (existingEmail) {
      // Create nothing, issue no token, never emit EMAIL_CONFIRMATION_SENT —
      // that event would itself become the oracle the response no longer is.
      // This server-side-only event is where a repeat attempt stays visible.
      await tryRecordSecurityEvent({
        type: "REGISTER_DUPLICATE_EMAIL",
        userId: existingEmail.id,
        projectId,
        ip,
        userAgent,
      });

      await sendMail(existingAccountEmail(email));
    } else {
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { project_id: projectId, email, username, first_name, last_name },
        });

        await tx.account.create({
          data: {
            user_id: created.id,
            project_id: projectId,
            provider_id: CREDENTIAL_PROVIDER,
            account_id: created.id,
            password: passwordHash,
          },
        });

        await recordSecurityEvent(
          {
            type: "USER_REGISTERED",
            userId: created.id,
            sessionId: null,
            projectId,
            ip,
            userAgent,
            metadata: { provider: CREDENTIAL_PROVIDER },
          },
          tx,
        );

        return created;
      });

      const verificationToken = await issueRecoveryToken(
        user.id,
        "EMAIL_CONFIRMATION",
        projectId,
      );

      await sendMail(verificationEmail(user.email, verificationToken));
      await tryRecordSecurityEvent({
        type: "EMAIL_CONFIRMATION_SENT",
        userId: user.id,
        projectId,
        ip,
        userAgent,
      });
    }

    // Byte-identical on both branches: same status, same body, no tokens, no
    // session, no user, no device id, no MFA grace field. Clients call /login
    // next; MFA grace is stamped there.
    res.status(202).json({
      message: "If that address is valid, we've sent a confirmation email.",
    });
  } catch (error) {
    next(error);
  }
};

export const login: RequestHandler = async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const { email, password } = parsed.data;
    const projectId = requireProjectId(req);
    const context = clientContext(req, requireDeviceId(req), projectId);

    const user = await prisma.user.findUnique({
      where: { project_id_email: { project_id: projectId, email } },
      include: {
        accounts: { where: { provider_id: CREDENTIAL_PROVIDER }, take: 1 },
      },
    });

    const credential = user?.accounts[0];
    // One comparison runs on every path — the dummy-hash fallback covers the
    // unknown-account and no-credential cases — so timing cannot separate
    // them from a real bad-password attempt.
    const passwordMatches = await verifyPassword(password, credential?.password);

    if (!user || !passwordMatches) {
      await tryRecordSecurityEvent({
        type: "LOGIN_FAILED",
        userId: user?.id ?? null,
        projectId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: {
          email,
          reason: !user
            ? "unknown_account"
            : credential?.password == null
              ? "no_credential_account"
              : "bad_password",
        },
      });

      return next(appError(401, "Invalid credentials", "auth_failed"));
    }

    // Checked only after the password, so the verification state of an account
    // is never disclosed to someone who cannot already sign in.
    if (config.require_email_verification && !user.email_verified) {
      await tryRecordSecurityEvent({
        type: "LOGIN_FAILED",
        userId: user.id,
        projectId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { email, reason: "email_not_verified" },
      });

      return next(
        appError(403, "Email address not confirmed", "email_not_verified"),
      );
    }

    // An enrolled user's sign-in pauses here instead of creating a session:
    // possession of the password alone must not be enough. The prior session
    // deliberately survives until phase two — revoking now would let whoever
    // holds the challenge token lock the real user out entirely.
    if (user.mfa_enrolled_at) {
      const challengeToken = await issueRecoveryToken(
        user.id,
        "MFA_CHALLENGE",
        projectId,
        context.deviceId,
      );

      return res.status(200).json({
        mfaRequired: true,
        challengeToken,
        expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS,
        deviceId: context.deviceId,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      await revokeSessions(
        tx,
        { user_id: user.id, device_id: context.deviceId },
        "replaced_by_new_login",
      );

      const created = await createSession(tx, user.id, projectId, context, user.role);

      await recordSecurityEvent(
        {
          type: "LOGIN_SUCCESS",
          userId: user.id,
          sessionId: created.session.id,
          projectId,
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { provider: CREDENTIAL_PROVIDER },
        },
        tx,
      );

      const mfaGraceEndsAt = await stampMfaGrace(tx, user, projectId);

      return { ...created, mfaGraceEndsAt };
    });

    sendAuthResponse(
      req,
      res,
      {
        accessToken: result.accessToken.token,
        refreshToken: result.refreshToken.token,
      },
      {
        ...(result.mfaGraceEndsAt && {
          mfaGraceEndsAt: result.mfaGraceEndsAt.toISOString(),
        }),
      },
      200,
      context.deviceId,
    );
  } catch (error) {
    next(error);
  }
};

export const refresh: RequestHandler = async (req, res, next) => {
  try {
    // A cookie client sends nothing in the body; a bearer client sends no cookie.
    const supplied =
      (req.body as { refreshToken?: unknown } | undefined)?.refreshToken ??
      readRefreshCookie(req);

    const parsed = refreshTokenSchema.safeParse(supplied);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const deviceId = requireDeviceId(req);
    const presented = parseRefreshToken(parsed.data);

    if (!presented) {
      return next(appError(401, "Invalid refresh token", "token_invalid"));
    }

    const storedToken = await prisma.refreshToken.findUnique({
      where: { selector: presented.selector },
      include: {
        session: { include: { user: { select: { role: true } } } },
      },
    });

    if (!storedToken) {
      return next(appError(401, "Invalid refresh token", "token_invalid"));
    }

    // Project id is derived from the token's own row, never re-read from the
    // client: refresh operates on a record that already belongs to exactly
    // one project, so there's nothing for a client-supplied id to add except
    // an opportunity to spoof it.
    const context = clientContext(req, deviceId, storedToken.project_id);

    // The verifier is checked before any revocation decision: acting on a bare
    // selector would let anyone who observed one kill a stranger's session.
    const verifierMatches = await bcrypt.compare(
      presented.verifier,
      storedToken.token_hash,
    );

    if (!verifierMatches) {
      return next(appError(401, "Invalid refresh token", "token_invalid"));
    }

    const now = new Date();

    // Only a token that was already exchanged is evidence of theft. A token we
    // revoked ourselves (logout, password change) is not, and must not escalate.
    if (storedToken.consumed_at || storedToken.status === "CONSUMED") {
      await prisma.$transaction(async (tx) => {
        await revokeRefreshFamily(
          tx,
          storedToken.family_id,
          storedToken.session_id,
          "refresh_token_reuse_detected",
        );

        await recordSecurityEvent(
          {
            type: "REFRESH_REUSE_DETECTED",
            userId: storedToken.user_id,
            sessionId: storedToken.session_id,
            projectId: context.projectId,
            ip: context.ip,
            userAgent: context.userAgent,
            metadata: {
              family_id: storedToken.family_id,
              consumed_at: storedToken.consumed_at?.toISOString() ?? null,
            },
          },
          tx,
        );
      });

      return next(
        appError(
          401,
          "Refresh token reuse detected. Session revoked.",
          "token_reused",
        ),
      );
    }

    if (storedToken.status === "REVOKED" || storedToken.revoked_at) {
      return next(appError(401, "Refresh token revoked", "token_revoked"));
    }

    if (storedToken.status === "EXPIRED" || storedToken.expires_at <= now) {
      await prisma.$transaction([
        prisma.refreshToken.update({
          where: { id: storedToken.id },
          data: { status: "EXPIRED" },
        }),
        prisma.session.updateMany({
          where: { id: storedToken.session_id, status: "ACTIVE" },
          data: { status: "EXPIRED" },
        }),
      ]);

      return next(appError(401, "Refresh token expired", "token_expired"));
    }

    if (storedToken.status !== "ACTIVE") {
      return next(appError(401, "Invalid refresh token", "token_invalid"));
    }

    const { session } = storedToken;

    if (
      session.status !== "ACTIVE" ||
      session.revoked_at ||
      session.expires_at <= now
    ) {
      return next(
        appError(401, "Session is no longer active", "session_inactive"),
      );
    }

    if (session.device_id && session.device_id !== context.deviceId) {
      return next(
        appError(
          401,
          "Refresh token does not match the current device context",
          "device_mismatch",
        ),
      );
    }

    // Checked after the device match on purpose: a wrong-device presenter must
    // get a flat rejection without mutating anything, not be able to expire
    // someone else's session. Unlike requireAuth's read-only idle check,
    // refresh already owns a transaction, so the legitimate idle client gets
    // its session marked EXPIRED here rather than left in limbo. No
    // SecurityEvent, matching the expired-by-clock branch above — expiry is a
    // retention transition, not a security one.
    if (isInactive(session, now)) {
      await prisma.$transaction([
        prisma.refreshToken.update({
          where: { id: storedToken.id },
          data: { status: "EXPIRED" },
        }),
        prisma.session.updateMany({
          where: { id: storedToken.session_id, status: "ACTIVE" },
          data: { status: "EXPIRED" },
        }),
      ]);

      return next(appError(401, "Session has expired", "session_expired"));
    }

    const nextRefreshTokenId = crypto.randomUUID();
    const { accessToken, refreshToken } = generateTokens({
      userId: storedToken.user_id,
      familyId: storedToken.family_id,
      sessionId: storedToken.session_id,
      projectId: context.projectId,
      // Re-read at every rotation, so a role change reaches new tokens on the
      // next refresh even though authorization never waited for that.
      role: storedToken.session.user.role,
    });

    // Sliding expiry: activity pushes the session's whole horizon out to a
    // fresh TTL, and the replacement token dies with the session it belongs
    // to, so the advertised lifetime and the enforced one agree.
    const slidingExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const refreshExpiresAt = slidingExpiresAt;

    await prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({
        where: { id: storedToken.id },
        data: {
          status: "CONSUMED",
          consumed_at: now,
          consumed_by_ip: context.ip,
          consumed_by_user_agent: context.userAgent,
          replaced_by_token_id: nextRefreshTokenId,
        },
      });

      await tx.session.update({
        where: { id: storedToken.session_id },
        data: {
          last_used_at: now,
          expires_at: slidingExpiresAt,
          user_agent_last: context.userAgent,
          ip_last: context.ip,
        },
      });

      await tx.refreshToken.create({
        data: {
          id: nextRefreshTokenId,
          selector: refreshToken.selector,
          session_id: storedToken.session_id,
          user_id: storedToken.user_id,
          project_id: storedToken.project_id,
          family_id: storedToken.family_id,
          token_hash: await bcrypt.hash(
            refreshToken.verifier,
            REFRESH_HASH_ROUNDS,
          ),
          expires_at: refreshExpiresAt,
          created_by_ip: context.ip,
          created_by_user_agent: context.userAgent,
        },
      });

      await recordSecurityEvent(
        {
          type: "REFRESH_SUCCESS",
          userId: storedToken.user_id,
          sessionId: storedToken.session_id,
          projectId: context.projectId,
          ip: context.ip,
          userAgent: context.userAgent,
        },
        tx,
      );
    });

    sendAuthResponse(
      req,
      res,
      { accessToken: accessToken.token, refreshToken: refreshToken.token },
      {},
    );
  } catch (error) {
    next(error);
  }
};

export const logout: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = requireProjectId(req);
    const context = clientContext(req, requireDeviceId(req), projectId);

    await prisma.$transaction(async (tx) => {
      const revoked = await revokeSessions(
        tx,
        { user_id: userId, device_id: context.deviceId },
        "user_logout",
      );

      await recordSecurityEvent(
        {
          type: "LOGOUT",
          userId,
          sessionId: revoked[0] ?? null,
          projectId,
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { revoked_sessions: revoked.length },
        },
        tx,
      );
    });

    clearAuthCookies(res);

    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    next(error);
  }
};
