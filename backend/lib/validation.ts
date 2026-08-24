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

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword,
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  min_password_length: z.number().int().min(8).max(128).optional(),
});

export const updateProjectSchema = z.object({
  min_password_length: z.number().int().min(8).max(128).nullable(),
});

export const issueApiKeySchema = z.object({
  type: z.enum(["PUBLISHABLE", "SECRET"]),
});
