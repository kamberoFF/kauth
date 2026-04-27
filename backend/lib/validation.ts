// lib/validation.ts
import { z } from "zod";

export const registerSchema = z.object({
  email: z.email(),
  username: z.string().min(3),
  password: z.string().min(8),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
