import { type RequestHandler } from "express";
import { prisma } from "../lib/prisma";
import { mfaCodeSchema } from "../lib/validation";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";
import { buildOtpauthUri, generateTotpSecret, matchTotpStep } from "../lib/totp";
import { decrypt, encrypt } from "../lib/cryptoBox";
import { generateBackupCodes, hashBackupCode } from "../lib/backupCodes";
import { recordSecurityEvent, requestContext } from "../lib/securityEvents";

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
