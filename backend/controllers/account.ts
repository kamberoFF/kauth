import { type RequestHandler } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma";
import {
  changePasswordSchema,
  emailSchema,
  resetPasswordSchema,
  tokenSchema,
} from "../lib/validation";
import { appError } from "../utils/errors";
import { requireProjectId, requireUserId } from "../utils/requestGuards";
import { CREDENTIAL_PROVIDER } from "../constants/providers";
import {
  consumeRecoveryToken,
  issueRecoveryToken,
} from "../lib/recoveryTokens";
import {
  passwordResetEmail,
  sendMail,
  verificationEmail,
} from "../lib/mail";
import { revokeSessions } from "../lib/sessions";
import {
  recordSecurityEvent,
  requestContext,
  tryRecordSecurityEvent,
} from "../lib/securityEvents";

const PASSWORD_HASH_ROUNDS = 10;

/**
 * Recovery endpoints answer identically whether or not the address is
 * registered. Anything else turns them into account-existence oracles.
 */
const GENERIC_RECOVERY_RESPONSE = {
  message: "If that account exists, we have sent an email.",
};

export const sendVerificationEmail: RequestHandler = async (req, res, next) => {
  try {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const context = requestContext(req);
    const projectId = requireProjectId(req);
    const user = await prisma.user.findUnique({
      where: { project_id_email: { project_id: projectId, email: parsed.data.email } },
    });

    if (user && !user.email_verified) {
      const token = await issueRecoveryToken(
        user.id,
        "EMAIL_CONFIRMATION",
        projectId,
      );

      await sendMail(verificationEmail(user.email, token));
      await tryRecordSecurityEvent({
        type: "EMAIL_CONFIRMATION_SENT",
        userId: user.id,
        projectId,
        ...context,
      });
    }

    res.status(202).json(GENERIC_RECOVERY_RESPONSE);
  } catch (error) {
    next(error);
  }
};

export const verifyEmail: RequestHandler = async (req, res, next) => {
  try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const context = requestContext(req);

    await prisma.$transaction(async (tx) => {
      const record = await consumeRecoveryToken(
        parsed.data.token,
        "EMAIL_CONFIRMATION",
        tx,
      );

      if (!record) {
        throw appError(400, "Invalid or expired token", "token_invalid");
      }

      await tx.user.update({
        where: { id: record.user_id },
        data: { email_verified: true },
      });

      await recordSecurityEvent(
        {
          type: "EMAIL_CONFIRMED",
          userId: record.user_id,
          projectId: record.project_id,
          ...context,
        },
        tx,
      );
    });

    res.json({ message: "Email confirmed" });
  } catch (error) {
    next(error);
  }
};

export const forgotPassword: RequestHandler = async (req, res, next) => {
  try {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const context = requestContext(req);
    const projectId = requireProjectId(req);
    const user = await prisma.user.findUnique({
      where: { project_id_email: { project_id: projectId, email: parsed.data.email } },
      include: {
        accounts: { where: { provider_id: CREDENTIAL_PROVIDER }, take: 1 },
      },
    });

    // A social-only account has no password to reset, so no email goes out.
    if (user && user.accounts.length > 0) {
      const token = await issueRecoveryToken(user.id, "PASSWORD_RESET", projectId);

      await sendMail(passwordResetEmail(user.email, token));
      await tryRecordSecurityEvent({
        type: "PASSWORD_RESET_REQUESTED",
        userId: user.id,
        projectId,
        ...context,
      });
    }

    res.status(202).json(GENERIC_RECOVERY_RESPONSE);
  } catch (error) {
    next(error);
  }
};

export const resetPassword: RequestHandler = async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const context = requestContext(req);
    // Hashed before the transaction so the work does not hold a connection.
    const passwordHash = await bcrypt.hash(
      parsed.data.password,
      PASSWORD_HASH_ROUNDS,
    );

    await prisma.$transaction(async (tx) => {
      const record = await consumeRecoveryToken(
        parsed.data.token,
        "PASSWORD_RESET",
        tx,
      );

      if (!record) {
        throw appError(400, "Invalid or expired token", "token_invalid");
      }

      const updated = await tx.account.updateMany({
        where: {
          user_id: record.user_id,
          provider_id: CREDENTIAL_PROVIDER,
        },
        data: { password: passwordHash },
      });

      if (updated.count === 0) {
        throw appError(
          400,
          "This account has no password to reset",
          "no_credential_account",
        );
      }

      // A reset is recovery from possible compromise, so every session dies,
      // and completing it proves the user controls the mailbox.
      await revokeSessions(tx, { user_id: record.user_id }, "password_reset");

      await tx.user.update({
        where: { id: record.user_id },
        data: { email_verified: true },
      });

      await recordSecurityEvent(
        {
          type: "PASSWORD_RESET_COMPLETED",
          userId: record.user_id,
          projectId: record.project_id,
          ...context,
        },
        tx,
      );
    });

    res.json({ message: "Password updated. Please sign in again." });
  } catch (error) {
    next(error);
  }
};

export const changePassword: RequestHandler = async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError(400, "Invalid input", "validation"));

    const userId = requireUserId(req);
    const projectId = requireProjectId(req);
    const context = requestContext(req);

    const account = await prisma.account.findUnique({
      where: {
        user_id_provider_id: {
          user_id: userId,
          provider_id: CREDENTIAL_PROVIDER,
        },
      },
    });

    if (!account?.password) {
      return next(
        appError(
          400,
          "This account has no password set",
          "no_credential_account",
        ),
      );
    }

    const currentMatches = await bcrypt.compare(
      parsed.data.currentPassword,
      account.password,
    );

    if (!currentMatches) {
      await tryRecordSecurityEvent({
        type: "LOGIN_FAILED",
        userId,
        projectId,
        ...context,
        metadata: { reason: "bad_password", action: "change_password" },
      });

      return next(appError(401, "Invalid credentials", "auth_failed"));
    }

    const passwordHash = await bcrypt.hash(
      parsed.data.newPassword,
      PASSWORD_HASH_ROUNDS,
    );

    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: account.id },
        data: { password: passwordHash },
      });

      await revokeSessions(tx, { user_id: userId }, "password_changed");

      await recordSecurityEvent(
        { type: "PASSWORD_CHANGED", userId, projectId, ...context },
        tx,
      );
    });

    res.json({ message: "Password updated. Please sign in again." });
  } catch (error) {
    next(error);
  }
};

export const listLinkedAccounts: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = requireProjectId(req);

    // project_id is redundant here — a User row is itself project-scoped by
    // construction, so every Account hanging off it already belongs to the
    // caller's own project — but included anyway for the same
    // belt-and-suspenders reason requireAuth checks it explicitly too.
    const accounts = await prisma.account.findMany({
      where: { user_id: userId, project_id: projectId },
      orderBy: { created_at: "asc" },
      select: { id: true, provider_id: true, created_at: true, updated_at: true },
    });

    res.json({
      accounts: accounts.map((account) => ({
        id: account.id,
        providerId: account.provider_id,
        linkedAt: account.created_at,
        updatedAt: account.updated_at,
      })),
    });
  } catch (error) {
    next(error);
  }
};

export const unlinkAccount: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = requireProjectId(req);
    const providerId = req.params.providerId ?? "";
    const context = requestContext(req);

    await prisma.$transaction(async (tx) => {
      // Locks every one of the caller's account rows before counting them.
      // A plain count-then-delete would let two concurrent unlink requests
      // (one per remaining provider) each read "2 remain" before either
      // commits, and both would pass the guard below — this forces the
      // second request to wait for the first to commit its delete, so it
      // recounts against the post-delete state instead.
      await tx.$queryRaw`SELECT id FROM "accounts" WHERE user_id = ${userId}::uuid FOR UPDATE`;

      const target = await tx.account.findUnique({
        where: { user_id_provider_id: { user_id: userId, provider_id: providerId } },
      });

      // Same belt-and-suspenders shape as revokeSession: user_id alone
      // already implies the project, but checking project_id explicitly
      // too costs nothing and keeps this endpoint consistent with how its
      // sibling self-service endpoints scope ownership.
      if (!target || target.project_id !== projectId) {
        throw appError(404, "Linked account not found", "account_not_found");
      }

      const remaining = await tx.account.count({ where: { user_id: userId } });

      // Removing this row must never leave the account with zero sign-in
      // methods of any kind, credential or OAuth.
      if (remaining <= 1) {
        throw appError(
          400,
          "Cannot remove your only sign-in method",
          "only_sign_in_method",
        );
      }

      await tx.account.delete({ where: { id: target.id } });

      await recordSecurityEvent(
        {
          type: "ACCOUNT_UNLINKED",
          userId,
          projectId: target.project_id,
          ...context,
          metadata: { provider: providerId },
        },
        tx,
      );
    });

    res.json({ message: "Account unlinked" });
  } catch (error) {
    next(error);
  }
};
