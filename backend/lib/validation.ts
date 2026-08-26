import { z } from "zod";

/**
 * Only shape is validated here. The minimum length is per-Project policy
 * (lib/passwords.ts resolves it), so the controllers that know the Project
 * enforce the floor — a static schema cannot. The cap is a request-size
 * bound, not an algorithm limit: Argon2id has no bcrypt-style truncation.
 */
const newPassword = z.string().min(1).max(200);

export const registerSchema = z.object({
  email: z.email(),
  username: z.string().min(3),
  password: newPassword,
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.email(),
  // Deliberately no length floor: legacy credentials shorter than today's
  // policy must still be able to log in and be rotated.
  password: z.string().min(1).max(200),
});

/**
 * Validates the token value itself rather than a body field, because it may
 * arrive either in the JSON body or in the refresh cookie.
 */
export const refreshTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "Invalid refresh token format");

export const emailSchema = z.object({
  email: z.email(),
});

export const tokenSchema = z.object({
  token: z.string().min(1),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: newPassword,
});

export const oauthExchangeSchema = z.object({
  code: z.string().min(1),
});

/**
 * Phase two of an enrolled sign-in. Same shape-only rule as mfaCodeSchema:
 * a well-formed but wrong challenge token or code is an auth failure, not a
 * validation failure.
 */
export const mfaChallengeSchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(1).max(20),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword,
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  min_password_length: z.number().int().min(8).max(128).optional(),
});

/**
 * Partial-update semantics: an absent field means "leave as is", an explicit
 * null clears it back to the deployment default. mfa_grace_days rejects
 * out-of-clamp values rather than clamping them — a silently shortened or
 * lengthened lockout window is a policy decision an owner should have to
 * state correctly.
 */
export const updateProjectSchema = z.object({
  min_password_length: z.number().int().min(8).max(128).nullable().optional(),
  enforce_mfa: z.boolean().optional(),
  mfa_grace_days: z.number().int().min(3).max(90).nullable().optional(),
});

export const issueApiKeySchema = z.object({
  type: z.enum(["PUBLISHABLE", "SECRET"]),
});

/**
 * Shape only: a TOTP code that fails the regex check inside matchTotpStep is
 * a *wrong* code (401), not a validation failure — the boundary between the
 * two is what keeps malformed input and bad credentials distinguishable.
 */
export const mfaCodeSchema = z.object({
  code: z.string().min(1).max(20),
});

/**
 * Step-up disable. Same shape-only rule as mfaCodeSchema, and deliberately no
 * length floor on the password: legacy credentials shorter than today's
 * policy must still be able to prove ownership (same reasoning as
 * loginSchema).
 */
export const mfaDisableSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().min(1).max(20),
});
