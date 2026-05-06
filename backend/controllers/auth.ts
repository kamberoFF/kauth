import { type Response, type NextFunction } from "express";
import bcrypt from "bcrypt";
import { generateTokens, verifyRefreshToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { registerSchema, loginSchema, refreshSchema } from "../lib/validation";
import type { DeviceRequest, AuthDeviceRequest } from "../types/auth";
import { appError } from "../utils/errors";

export const register = async (
  req: DeviceRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError("Invalid input", 400, "validation"));

    const { email, username, password, first_name, last_name } = parsed.data;
    const deviceId = req.deviceId!;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing)
      return next(appError("User already exists", 409, "duplicate_email"));

    const passwordHash = await bcrypt.hash(password, 10);

    // ✅ Atomic: user + token creation
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          username,
          password: passwordHash,
          first_name,
          last_name,
        },
      });
      const tokens = generateTokens(user.id);
      await tx.refreshToken.create({
        data: { id: tokens.r_jwtid, deviceId, user_id: user.id },
      });
      return { user, tokens };
    });

    res.status(201).json({
      user: {
        id: result.user.id,
        username: result.user.username,
        email: result.user.email,
        firstName: first_name,
        lastName: last_name,
      },
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
    });
  } catch (error) {
    next(error);
  }
};

export const login = async (
  req: DeviceRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError("Invalid input", 400, "validation"));

    const { email, password } = parsed.data;
    const deviceId = req.deviceId!;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return next(appError("Invalid credentials", 401, "auth_failed"));
    }

    const { accessToken, refreshToken, r_jwtid } = generateTokens(user.id);

    // ✅ Atomic: remove old device session + create new token
    await prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({
        where: { user_id: user.id, deviceId },
      });
      await tx.refreshToken.create({
        data: { id: r_jwtid, deviceId, user_id: user.id },
      });
    });

    res.json({ accessToken, refreshToken });
  } catch (error) {
    next(error);
  }
};

export const refresh = async (
  req: DeviceRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success)
      return next(appError("Invalid input", 400, "validation"));

    const { refreshToken } = parsed.data;
    const deviceId = req.deviceId!;

    const payload = verifyRefreshToken(refreshToken);
    if (!payload)
      return next(appError("Invalid refresh token", 401, "token_invalid"));

    const tokenCheck = await prisma.refreshToken.findUnique({
      where: { id: payload.jwtid },
    });

    if (!tokenCheck) {
      // 🚨 Compromised: revoke all sessions & reject
      await prisma.refreshToken.deleteMany({
        where: { user_id: payload.userId },
      });
      console.warn(
        `Compromised session detected for user ${payload.userId}. All tokens revoked.`,
      );
      return next(
        appError(
          "Session compromised. All tokens revoked.",
          401,
          "compromised",
        ),
      );
    }

    const {
      accessToken,
      refreshToken: newRefreshToken,
      r_jwtid,
    } = generateTokens(payload.userId);

    // ✅ Atomic rotation: delete old + create new
    await prisma.$transaction(async (tx) => {
      await tx.refreshToken.delete({ where: { id: payload.jwtid } });
      await tx.refreshToken.create({
        data: { id: r_jwtid, deviceId, user_id: payload.userId },
      });
    });

    res.json({ accessToken, newRefreshToken });
  } catch (error) {
    next(error);
  }
};

export const logout = async (
  req: AuthDeviceRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.userId!;
    const deviceId = req.deviceId!;

    // ✅ deleteMany won't crash if token already gone
    await prisma.refreshToken.deleteMany({
      where: { user_id: userId, deviceId },
    });
    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    next(error);
  }
};
