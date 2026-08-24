import crypto from "node:crypto";
import { prisma } from "./prisma";
import type { Prisma } from "../generated/prisma/client";
import type { TokenType } from "../generated/prisma/enums";

type DbClient = Prisma.TransactionClient | typeof prisma;

const TOKEN_BYTES = 32;

const TTL_MS: Record<TokenType, number> = {
  EMAIL_CONFIRMATION: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
  // Only has to survive one redirect back to the frontend.
  OAUTH_EXCHANGE: 2 * 60 * 1000,
  // Bridges the two phases of an enrolled user's sign-in; issuance and
  // verification land in a later ticket.
  MFA_CHALLENGE: 5 * 60 * 1000,
};

/**
 * A fast hash is correct here: the token carries 256 bits of entropy, so there
 * is nothing for an offline attacker to brute force. Only the hash is stored,
 * so a database leak does not hand over working reset links.
 */
function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueRecoveryToken(
  userId: string,
  type: TokenType,
  projectId: string,
  client: DbClient = prisma,
) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const now = new Date();

  // One live token per purpose: requesting a new link must retire the old one.
  await client.recoveryToken.updateMany({
    where: { user_id: userId, token_type: type, consumed_at: null },
    data: { consumed_at: now },
  });

  await client.recoveryToken.create({
    data: {
      user_id: userId,
      project_id: projectId,
      token_type: type,
      token_hash: hashToken(token),
      expires_at: new Date(now.getTime() + TTL_MS[type]),
    },
  });

  return token;
}

/**
 * Reads a token record without consuming it. Exists so callers that need a
 * token's context before deciding anything destructive — resetPassword reads
 * its Project's password policy — can do so without spending single-use-ness.
 */
export function peekRecoveryToken(token: string) {
  return prisma.recoveryToken.findUnique({
    where: { token_hash: hashToken(token) },
  });
}

/**
 * Returns the token record and marks it used, or null when the token is
 * unknown, of the wrong type, already used, or expired. The conditional update
 * is what makes it single-use under concurrent requests.
 */
export async function consumeRecoveryToken(
  token: string,
  type: TokenType,
  client: DbClient = prisma,
) {
  const record = await client.recoveryToken.findUnique({
    where: { token_hash: hashToken(token) },
  });

  if (
    !record ||
    record.token_type !== type ||
    record.consumed_at ||
    record.expires_at <= new Date()
  ) {
    return null;
  }

  const claimed = await client.recoveryToken.updateMany({
    where: { id: record.id, consumed_at: null },
    data: { consumed_at: new Date() },
  });

  return claimed.count === 1 ? record : null;
}
