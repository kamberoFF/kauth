import { z } from "zod";

/**
 * bcrypt silently truncates input past 72 bytes, so anything longer would only
 * appear to be a stronger password. The cap goes away when hashing moves to
 * Argon2id.
 */
const newPassword = z.string().min(8).max(72);

export const registerSchema = z.object({
  email: z.email(),
  username: z.string().min(3),
  password: newPassword,
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
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
});

export const issueApiKeySchema = z.object({
  type: z.enum(["PUBLISHABLE", "SECRET"]),
});
