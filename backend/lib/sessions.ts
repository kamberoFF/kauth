import crypto from "node:crypto";
import bcrypt from "bcrypt";
import type { Request } from "express";
import { generateTokens } from "./jwt";
import { prisma } from "./prisma";
import type { Prisma } from "../generated/prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const REFRESH_HASH_ROUNDS = 10;

export type RevocationReason =
  | "user_logout"
  | "replaced_by_new_login"
  | "refresh_token_reuse_detected"
  | "password_changed"
  | "password_reset";

export interface ClientContext {
  deviceId: string;
  ip: string | null;
  userAgent: string | null;
}

export function clientContext(req: Request, deviceId: string): ClientContext {
  return {
    deviceId,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

export function sessionExpiry() {
  return new Date(Date.now() + SESSION_TTL_MS);
}

/**
 * Creates a fresh session plus the first refresh token of a new family.
 * Shared by registration, credential login, and the OAuth callback so all three
 * produce identical session state.
 */
export async function createSession(
  tx: DbClient,
  userId: string,
  context: ClientContext,
) {
  const familyId = crypto.randomUUID();
  // The id is allocated up front because the access token has to carry it, and
  // the token is minted before the row exists.
  const sessionId = crypto.randomUUID();
  const { accessToken, refreshToken } = generateTokens({
    userId,
    familyId,
    sessionId,
  });
  const now = new Date();
  const expiresAt = sessionExpiry();

  const session = await tx.session.create({
    data: {
      id: sessionId,
      user_id: userId,
      device_id: context.deviceId,
      expires_at: expiresAt,
      last_used_at: now,
      user_agent_created: context.userAgent,
      user_agent_last: context.userAgent,
      ip_created: context.ip,
      ip_last: context.ip,
    },
  });

  await tx.refreshToken.create({
    data: {
      selector: refreshToken.selector,
      session_id: session.id,
      user_id: userId,
      family_id: familyId,
      token_hash: await bcrypt.hash(refreshToken.verifier, REFRESH_HASH_ROUNDS),
      expires_at: expiresAt,
      created_by_ip: context.ip,
      created_by_user_agent: context.userAgent,
    },
  });

  return { session, accessToken, refreshToken };
}

/**
 * Kills every rotation of one refresh chain along with the session that owns
 * it. Used when a consumed token is replayed, which is the strongest signal of
 * theft the server gets.
 */
export async function revokeRefreshFamily(
  tx: DbClient,
  familyId: string,
  sessionId: string,
  reason: RevocationReason,
) {
  const now = new Date();

  await tx.refreshToken.updateMany({
    where: { family_id: familyId, status: "ACTIVE" },
    data: { status: "REVOKED", revoked_at: now },
  });

  await tx.session.updateMany({
    where: { id: sessionId, status: "ACTIVE" },
    data: { status: "REVOKED", revoked_at: now, revoked_reason: reason },
  });
}

/**
 * Sessions are revoked rather than deleted: the audit log references them, and
 * a deleted row takes its own evidence with it.
 */
export async function revokeSessions(
  tx: DbClient,
  where: Prisma.SessionWhereInput,
  reason: RevocationReason,
) {
  const now = new Date();

  const sessions = await tx.session.findMany({
    where: { ...where, status: "ACTIVE" },
    select: { id: true },
  });

  if (sessions.length === 0) {
    return [];
  }

  const sessionIds = sessions.map((session) => session.id);

  await tx.session.updateMany({
    where: { id: { in: sessionIds } },
    data: { status: "REVOKED", revoked_at: now, revoked_reason: reason },
  });

  await tx.refreshToken.updateMany({
    where: { session_id: { in: sessionIds }, status: "ACTIVE" },
    data: { status: "REVOKED", revoked_at: now },
  });

  return sessionIds;
}
