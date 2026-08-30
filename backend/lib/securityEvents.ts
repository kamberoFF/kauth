import type { Request } from "express";
import { prisma } from "./prisma";
import { logger } from "./logger";
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
  ACCOUNT_UNLINKED: SecurityEventSeverity.WARNING,
  CSRF_VALIDATION_FAILED: SecurityEventSeverity.WARNING,
  SUSPICIOUS_ACTIVITY: SecurityEventSeverity.CRITICAL,
  API_KEY_ISSUED: SecurityEventSeverity.INFO,
  API_KEY_REVOKED: SecurityEventSeverity.WARNING,
  PROJECT_PASSWORD_POLICY_CHANGED: SecurityEventSeverity.WARNING,

  // Second-factor lifecycle. Enrollment is split so a generated-but-
  // unconfirmed secret still leaves a trace; a used backup code means the
  // authenticator itself was not part of the sign-in.
  MFA_ENROLLMENT_STARTED: SecurityEventSeverity.INFO,
  MFA_ENROLLED: SecurityEventSeverity.WARNING,
  MFA_DISABLED: SecurityEventSeverity.WARNING,
  BACKUP_CODE_USED: SecurityEventSeverity.WARNING,
  PROJECT_MFA_POLICY_CHANGED: SecurityEventSeverity.WARNING,

  // Privilege transition (ADR 0007 scope): a staff member changed a role.
  ROLE_CHANGED: SecurityEventSeverity.WARNING,

  // A register attempt on an address that already has an account (ADR 0008).
  // WARNING: a repeat attempt on a known address is mildly interesting, where
  // a first registration (USER_REGISTERED) is not.
  REGISTER_DUPLICATE_EMAIL: SecurityEventSeverity.WARNING,

  // A Project owner reconfigured a Provider app (ADR 0009). WARNING, matching
  // the other PROJECT_*_POLICY_CHANGED events — a config change worth seeing
  // in the log, not an alarm.
  PROJECT_OAUTH_CONFIG_CHANGED: SecurityEventSeverity.WARNING,
};

/**
 * `SESSION_REVOKED` is reachable from four surfaces, and the Project events
 * endpoint (owner + secret key) needs to show which one cut a given session.
 * Every call site writes this discriminator into `metadata` — `actor` plus the
 * id that identifies the actor on that surface.
 */
export type SessionRevocationActor =
  | { actor: "self" }
  | { actor: "owner"; actor_user_id: string }
  | { actor: "staff"; actor_user_id: string }
  | { actor: "api_key"; api_key_id: string };

export interface SecurityEventInput {
  type: SecurityEventType;
  userId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
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
      project_id: input.projectId ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      metadata: input.metadata,
    },
  });
}

/**
 * The one place a `SESSION_REVOKED` row is written, so the four revoke
 * surfaces (self / owner / staff / api_key) cannot drift apart on shape and
 * the `actor` discriminator is type-checked at every call site.
 */
export async function recordSessionRevoked(
  client: EventClient,
  input: {
    userId: string | null;
    sessionId: string;
    projectId: string | null;
    actor: SessionRevocationActor;
    context: { ip: string | null; userAgent: string | null };
  },
) {
  await recordSecurityEvent(
    {
      type: "SESSION_REVOKED",
      userId: input.userId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      ...input.context,
      metadata: input.actor,
    },
    client,
  );
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
    logger.error("failed to record security event", { eventType: input.type, error });
  }
}
