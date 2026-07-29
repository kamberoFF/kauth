import type { Request } from "express";
import { prisma } from "./prisma";
import type { Prisma } from "../generated/prisma/client";
import {
  SecurityEventSeverity,
  SecurityEventType,
} from "../generated/prisma/enums";

type EventClient = Prisma.TransactionClient | typeof prisma;

/**
 * Severity belongs with the event type rather than the call site, so that a
 * reuse detection is never accidentally logged as INFO.
 */
const SEVERITY: Record<SecurityEventType, SecurityEventSeverity> = {
  USER_REGISTERED: SecurityEventSeverity.INFO,
  LOGIN_SUCCESS: SecurityEventSeverity.INFO,
  LOGIN_FAILED: SecurityEventSeverity.WARNING,
  LOGOUT: SecurityEventSeverity.INFO,
  LOGOUT_ALL: SecurityEventSeverity.INFO,
  REFRESH_SUCCESS: SecurityEventSeverity.INFO,
  REFRESH_REUSE_DETECTED: SecurityEventSeverity.CRITICAL,
  SESSION_REVOKED: SecurityEventSeverity.WARNING,
  PASSWORD_CHANGED: SecurityEventSeverity.WARNING,
  PASSWORD_RESET_REQUESTED: SecurityEventSeverity.INFO,
  PASSWORD_RESET_COMPLETED: SecurityEventSeverity.WARNING,
  EMAIL_CONFIRMATION_SENT: SecurityEventSeverity.INFO,
  EMAIL_CONFIRMED: SecurityEventSeverity.INFO,
  OAUTH_LOGIN_SUCCESS: SecurityEventSeverity.INFO,
  OAUTH_LOGIN_FAILED: SecurityEventSeverity.WARNING,
  OAUTH_ACCOUNT_LINKED: SecurityEventSeverity.WARNING,
  CSRF_VALIDATION_FAILED: SecurityEventSeverity.WARNING,
  SUSPICIOUS_ACTIVITY: SecurityEventSeverity.CRITICAL,
};

export interface SecurityEventInput {
  type: SecurityEventType;
  userId?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Never put credentials, tokens, or token hashes here. Identifiers and
   * decision reasons only.
   */
  metadata?: Prisma.InputJsonValue;
  severity?: SecurityEventSeverity;
}

export function requestContext(req: Request) {
  return {
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

/**
 * Writes through the caller's transaction when one is supplied, so that a
 * revocation and its audit record commit or roll back together.
 */
export async function recordSecurityEvent(
  input: SecurityEventInput,
  client: EventClient = prisma,
) {
  await client.securityEvent.create({
    data: {
      event_type: input.type,
      severity: input.severity ?? SEVERITY[input.type],
      user_id: input.userId ?? null,
      session_id: input.sessionId ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      metadata: input.metadata,
    },
  });
}

/**
 * For events logged outside a transaction, where losing the audit row is
 * strictly better than failing the user's request.
 */
export async function tryRecordSecurityEvent(
  input: SecurityEventInput,
  client: EventClient = prisma,
) {
  try {
    await recordSecurityEvent(input, client);
  } catch (error) {
    console.error(`[audit] failed to record ${input.type}`, error);
  }
}
