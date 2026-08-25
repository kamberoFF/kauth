import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { mfaCodeSchema, mfaChallengeSchema } from "../lib/validation";
import { appError } from "../utils/errors";
import { requireDeviceId, requireProjectId, requireUserId } from "../utils/requestGuards";
import { buildOtpauthUri, generateTotpSecret, matchTotpStep } from "../lib/totp";
import { decrypt, encrypt } from "../lib/cryptoBox";
import { generateBackupCodes, hashBackupCode } from "../lib/backupCodes";
import { peekRecoveryToken } from "../lib/recoveryTokens";
import {
  clientContext,
  createSession,
  revokeSessions,
} from "../lib/sessions";
import { sendAuthResponse } from "../lib/tokenTransport";
import { recordSecurityEvent, requestContext, tryRecordSecurityEvent } from "../lib/securityEvents";
import { AppError } from "../types/errors";

/**
 * A stored secret with a null `mfa_enrolled_at` is a *pending* enrollment:
 * it challenges nothing at sign-in until the first valid code confirms it.
 */

function alreadyEnrolledError() {
  return appError(409, "MFA is already enabled", "mfa_already_enrolled");
}

/** Both lifecycle writes are conditional on the row still being pending —
 * without it, a verify landing between a restart's read and write would flip
 * enrollment under a secret nobody has confirmed. */

export const startMfaEnrollment: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = requireProjectId(req);
    const context = requestContext(req);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, username: true, mfa_enrolled_at: true },
    });

    if (user.mfa_enrolled_at) {
      return next(alreadyEnrolledError());
    }

    // Restarting a pending enrollment replaces the secret — the old one dies.
    const secret = generateTotpSecret();
    const encrypted = encrypt(secret);

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.user.updateMany({
        where: { id: userId, mfa_enrolled_at: null },
        data: { totp_secret: encrypted },
      });

      if (claimed.count === 0) {
        throw alreadyEnrolledError();
      }

      await recordSecurityEvent(
        { type: "MFA_ENROLLMENT_STARTED", userId, projectId, ...context },
        tx,
      );
    });

    res.json({
      otpauthUri: buildOtpauthUri(user.username ?? user.email, secret),
      secret,
    });
  } catch (error) {
    next(error);
  }
};

export const verifyMfaEnrollment: RequestHandler = async (req, res, next) => {
  try {
    const parsed = mfaCodeSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const userId = requireUserId(req);
    const projectId = requireProjectId(req);
    const context = requestContext(req);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totp_secret: true, mfa_enrolled_at: true },
    });

    if (!user.totp_secret || user.mfa_enrolled_at) {
      return next(
        appError(
          409,
          "No pending MFA enrollment",
          user.mfa_enrolled_at ? "mfa_already_enrolled" : "mfa_not_pending",
        ),
      );
    }

    const matchedStep = matchTotpStep(decrypt(user.totp_secret), parsed.data.code);

    if (matchedStep === null) {
      // Deliberately no security event here: the token submission limiter is
      // the control for code guessing, and noise-free audit beats noisy audit.
      return next(appError(401, "Invalid code", "mfa_code_invalid"));
    }

    // Generated before the transaction so the codes exist only in memory and
    // the response — never staged anywhere plaintext could linger.
    const backupCodes = generateBackupCodes();

    await prisma.$transaction(async (tx) => {
      // Claim conditions on the exact secret that was matched, not just on
      // being unenrolled: a restart that slips in after the read must void
      // this verification instead of enrolling the unconfirmed replacement.
      const claimed = await tx.user.updateMany({
        where: {
          id: userId,
          mfa_enrolled_at: null,
          totp_secret: user.totp_secret,
        },
        data: {
          mfa_enrolled_at: new Date(),
          last_totp_step: matchedStep,
          mfa_grace_ends_at: null,
        },
      });

      if (claimed.count === 0) {
        // Someone else won: either enrolled already, or the pending secret
        // was replaced. Re-read to name which, without guessing.
        const current = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { mfa_enrolled_at: true },
        });

        throw current.mfa_enrolled_at
          ? alreadyEnrolledError()
          : appError(409, "No pending MFA enrollment", "mfa_not_pending");
      }

      // A fresh enrollment never inherits stale codes from an earlier one.
      await tx.mfaBackupCode.deleteMany({ where: { user_id: userId } });
      await tx.mfaBackupCode.createMany({
        data: backupCodes.map((code) => ({
          user_id: userId,
          code_hash: hashBackupCode(code),
        })),
      });

      await recordSecurityEvent(
        { type: "MFA_ENROLLED", userId, projectId, ...context },
        tx,
      );
    });

    // Shown exactly once; only hashes survive this response.
    res.json({ backupCodes });
  } catch (error) {
    next(error);
  }
};

export const getMfaStatus: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        mfa_enrolled_at: true,
        mfa_grace_ends_at: true,
        _count: { select: { backupCodes: { where: { used_at: null } } } },
      },
    });

    res.json({
      enrolled: user.mfa_enrolled_at !== null,
      ...(user.mfa_grace_ends_at && { graceEndsAt: user.mfa_grace_ends_at }),
      ...(user.mfa_enrolled_at && {
        backupCodesRemaining: user._count.backupCodes,
      }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Phase two of an enrolled sign-in. The challenge token was issued by login
 * or the OAuth exchange, bound to the device that started the flow; completing
 * it runs the exact completion sequence a single-phase sign-in would have run.
 *
 * Every bad token state — unknown, wrong type, expired, already consumed, or
 * bound to a different device — answers the same `400 token_invalid`, so a
 * presenter learns nothing about which check failed. A wrong *code*, by
 * contrast, is `401 mfa_code_invalid` and leaves the token live until its TTL.
 */
export const verifyMfaChallenge: RequestHandler = async (req, res, next) => {
  try {
    const parsed = mfaChallengeSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const deviceId = requireDeviceId(req);

    // Peeked, not consumed: spending single-use-ness before the code checks
    // out would let one typo brick a login that should still be recoverable.
    const record = await peekRecoveryToken(parsed.data.challengeToken);

    if (
      !record ||
      record.token_type !== "MFA_CHALLENGE" ||
      record.consumed_at ||
      record.expires_at <= new Date() ||
      // resolveDevice mints an id when none is presented, so a cookie-less
      // caller can never accidentally satisfy this comparison.
      record.device_id !== deviceId
    ) {
      return next(appError(400, "Invalid or expired challenge", "token_invalid"));
    }

    const context = clientContext(req, deviceId, record.project_id);

    const user = await prisma.user.findUnique({
      where: { id: record.user_id },
      select: {
        id: true,
        mfa_enrolled_at: true,
        totp_secret: true,
        last_totp_step: true,
      },
    });

    // A challenge can outlive the enrollment it was issued for (disabled in
    // between); without an enrollment there is nothing left to verify.
    if (!user?.mfa_enrolled_at) {
      return next(appError(400, "Invalid or expired challenge", "token_invalid"));
    }

    const recordLoginFailed = () =>
      tryRecordSecurityEvent({
        type: "LOGIN_FAILED",
        userId: record.user_id,
        projectId: record.project_id,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: "mfa_code_invalid" },
      });

    const matchedStep = user.totp_secret
      ? matchTotpStep(decrypt(user.totp_secret), parsed.data.code)
      : null;

    let backupCodeId: string | null = null;

    if (matchedStep === null) {
      const backup = await prisma.mfaBackupCode.findFirst({
        where: {
          user_id: user.id,
          code_hash: hashBackupCode(parsed.data.code),
          used_at: null,
        },
        select: { id: true },
      });

      backupCodeId = backup?.id ?? null;
    }

    if (matchedStep === null && backupCodeId === null) {
      await recordLoginFailed();
      return next(appError(401, "Invalid code", "mfa_code_invalid"));
    }

    // Fast path of the replay guard: anything at or below the last used step
    // is dead on arrival. The transaction below re-enforces this atomically.
    if (
      matchedStep !== null &&
      user.last_totp_step !== null &&
      matchedStep <= user.last_totp_step
    ) {
      await recordLoginFailed();
      return next(appError(401, "Invalid code", "mfa_code_invalid"));
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Single-use gate: losing this conditional claim means a concurrent
        // request completed the challenge first.
        const claimed = await tx.recoveryToken.updateMany({
          where: { id: record.id, consumed_at: null },
          data: { consumed_at: new Date() },
        });

        if (claimed.count === 0) {
          throw appError(400, "Invalid or expired challenge", "token_invalid");
        }

        if (matchedStep !== null) {
          // Compare-and-set against the stored step: only strictly newer
          // steps count, no matter what earlier reads saw.
          const advanced = await tx.user.updateMany({
            where: {
              id: user.id,
              OR: [
                { last_totp_step: null },
                { last_totp_step: { lt: matchedStep } },
              ],
            },
            data: { last_totp_step: matchedStep },
          });

          if (advanced.count === 0) {
            throw appError(401, "Invalid code", "mfa_code_invalid");
          }
        }

        await revokeSessions(
          tx,
          { user_id: record.user_id, device_id: context.deviceId },
          "replaced_by_new_login",
        );

        const created = await createSession(
          tx,
          record.user_id,
          record.project_id,
          context,
        );

        if (backupCodeId !== null) {
          const burned = await tx.mfaBackupCode.updateMany({
            where: { id: backupCodeId, used_at: null },
            data: { used_at: new Date() },
          });

          if (burned.count === 0) {
            throw appError(401, "Invalid code", "mfa_code_invalid");
          }

          await recordSecurityEvent(
            {
              type: "BACKUP_CODE_USED",
              userId: record.user_id,
              sessionId: created.session.id,
              projectId: record.project_id,
              ip: context.ip,
              userAgent: context.userAgent,
            },
            tx,
          );
        }

        await recordSecurityEvent(
          {
            type: "LOGIN_SUCCESS",
            userId: record.user_id,
            sessionId: created.session.id,
            projectId: record.project_id,
            ip: context.ip,
            userAgent: context.userAgent,
            metadata: {
              method: matchedStep !== null ? "totp" : "backup_code",
            },
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
        200,
        deviceId,
      );
    } catch (error) {
      // A code rejection inside the transaction rolls everything back and
      // must still leave the same audit trail as the fast-path rejections.
      if (error instanceof AppError && error.code === "mfa_code_invalid") {
        await recordLoginFailed();
      }

      throw error;
    }
  } catch (error) {
    next(error);
  }
};
