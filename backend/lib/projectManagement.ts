import { prisma } from "./prisma";
import type { Prisma } from "../generated/prisma/client";
import {
  DeviceType,
  SecurityEventType,
  SessionStatus,
} from "../generated/prisma/enums";
import { UUID_REGEX } from "../constants/regex";
import { appError } from "../utils/errors";
import { decodeCursor, keysetAnd, parseLimit, toPage } from "./pagination";
import { revokeSessions, type RevocationReason } from "./sessions";
import {
  recordSessionRevoked,
  type SessionRevocationActor,
} from "./securityEvents";

/**
 * The Project-scoped management reads, shared by two callers that differ only
 * in how `req.projectId` was resolved: the owner's session
 * (`requireProjectOwnership`, an owned `:projectId`) and a secret API key
 * (`requireSecretKey`, the key's own Project). Every query here is scoped by
 * `projectId` alone, exactly like `controllers/projectAccess.ts`.
 */

export const USER_LIST_SELECT = {
  id: true,
  email: true,
  username: true,
  email_verified: true,
  role: true,
  created_at: true,
} as const;

export function serializeUser(user: {
  id: string;
  email: string;
  username: string | null;
  email_verified: boolean;
  role: "USER" | "ADMIN";
  created_at: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    emailVerified: user.email_verified,
    role: user.role,
    createdAt: user.created_at,
  };
}

/**
 * A Project's end users, oldest first — the one projection every caller of
 * this list wants (`GET /projects/:projectId/users`, `GET /project/users`).
 */
export async function listProjectUsers(projectId: string) {
  const users = await prisma.user.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: "asc" },
    select: USER_LIST_SELECT,
  });

  return { users: users.map(serializeUser) };
}

const SESSION_LIST_SELECT = {
  id: true,
  user_id: true,
  status: true,
  device_id: true,
  device_name: true,
  device_type: true,
  os_name: true,
  os_version: true,
  browser_name: true,
  browser_version: true,
  ip_created: true,
  ip_last: true,
  country_created: true,
  country_last: true,
  city_created: true,
  city_last: true,
  created_at: true,
  last_used_at: true,
  expires_at: true,
} as const;

function serializeSessionSummary(session: {
  id: string;
  user_id: string;
  status: SessionStatus;
  device_id: string | null;
  device_name: string | null;
  device_type: DeviceType | null;
  os_name: string | null;
  os_version: string | null;
  browser_name: string | null;
  browser_version: string | null;
  ip_created: string | null;
  ip_last: string | null;
  country_created: string | null;
  country_last: string | null;
  city_created: string | null;
  city_last: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
}) {
  return {
    id: session.id,
    userId: session.user_id,
    status: session.status,
    deviceId: session.device_id,
    deviceName: session.device_name,
    deviceType: session.device_type,
    osName: session.os_name,
    osVersion: session.os_version,
    browserName: session.browser_name,
    browserVersion: session.browser_version,
    ipCreated: session.ip_created,
    ipLast: session.ip_last,
    countryCreated: session.country_created,
    countryLast: session.country_last,
    cityCreated: session.city_created,
    cityLast: session.city_last,
    createdAt: session.created_at,
    lastUsedAt: session.last_used_at,
    expiresAt: session.expires_at,
  };
}

export interface SessionListQuery {
  userId?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

/**
 * `revoked_reason` (the session column) and `actor` (the audit metadata) are
 * two views of the same fact; deriving one from the other keeps a caller from
 * setting them out of lockstep.
 */
const REVOCATION_REASON_BY_ACTOR: Record<
  SessionRevocationActor["actor"],
  RevocationReason
> = {
  self: "user_revoked",
  owner: "owner_revoked",
  staff: "staff_revoked",
  api_key: "api_key_revoked",
};

/**
 * A Project's `ACTIVE` sessions, reverse-chronological, keyset-paginated,
 * optionally narrowed to one user. Revocation history lives in the event log,
 * not here — every session list in kauth is active-only. Response shape:
 * `{ sessions: [...], nextCursor: string | null }`.
 */
export async function listProjectSessions(
  projectId: string,
  query: SessionListQuery,
) {
  const userId = parseUserIdFilter(query.userId);
  const limit = parseLimit(query.limit);
  const cursor = decodeCursor(query.cursor);

  const rows = await prisma.session.findMany({
    where: {
      project_id: projectId,
      status: "ACTIVE",
      ...(userId ? { user_id: userId } : {}),
      AND: keysetAnd(cursor),
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: SESSION_LIST_SELECT,
  });

  const { rows: page, nextCursor } = toPage(rows, limit);

  return { sessions: page.map(serializeSessionSummary), nextCursor };
}

/**
 * One session, scoped to the Project — the same detail projection the
 * secret-key and staff surfaces return. `null` (never another Project's row)
 * when the id misses or points outside the Project; the caller turns that into
 * a `404`.
 */
export async function getProjectSession(projectId: string, sessionId: string) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, project_id: projectId },
    select: {
      id: true,
      user_id: true,
      status: true,
      created_at: true,
      last_used_at: true,
      expires_at: true,
      revoked_at: true,
    },
  });

  if (!session) {
    return null;
  }

  return {
    id: session.id,
    userId: session.user_id,
    status: session.status,
    createdAt: session.created_at,
    lastUsedAt: session.last_used_at,
    expiresAt: session.expires_at,
    revokedAt: session.revoked_at,
  };
}

/**
 * Revoke one `ACTIVE` session in a Project and audit who cut it. Shared by the
 * owner surface (`actor: "owner"`) and the secret-key surface
 * (`actor: "api_key"`); the two differ only in that discriminator, and the
 * `revoked_reason` is derived from it. A missing / already-revoked /
 * cross-Project id all collapse into one clean `404` — the surface discloses
 * nothing about other Projects.
 */
export async function revokeProjectSession(
  projectId: string,
  sessionId: string,
  actor: SessionRevocationActor,
  context: { ip: string | null; userAgent: string | null },
) {
  await prisma.$transaction(async (tx) => {
    const session = await tx.session.findFirst({
      where: { id: sessionId, project_id: projectId, status: "ACTIVE" },
      select: { id: true, user_id: true },
    });

    if (!session) {
      throw appError(404, "Session not found", "session_not_found");
    }

    await revokeSessions(
      tx,
      { id: sessionId, project_id: projectId },
      REVOCATION_REASON_BY_ACTOR[actor.actor],
    );

    await recordSessionRevoked(tx, {
      userId: session.user_id,
      sessionId: session.id,
      projectId,
      actor,
      context,
    });
  });
}

const EVENT_SELECT = {
  id: true,
  event_type: true,
  severity: true,
  user_id: true,
  session_id: true,
  ip: true,
  user_agent: true,
  metadata: true,
  created_at: true,
} as const;

function serializeEvent(event: {
  id: string;
  event_type: SecurityEventType;
  severity: string;
  user_id: string | null;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Prisma.JsonValue;
  created_at: Date;
}) {
  return {
    id: event.id,
    eventType: event.event_type,
    severity: event.severity,
    userId: event.user_id,
    sessionId: event.session_id,
    ip: event.ip,
    userAgent: event.user_agent,
    // Returned exactly as stored: CLAUDE.md forbids tokens/hashes/credentials
    // in metadata, and the identifiers that do land there (provider,
    // actor/actor_user_id, old_role/new_role, api_key_id) are things a Project
    // owner is entitled to see about their own Project.
    metadata: event.metadata,
    createdAt: event.created_at,
  };
}

const EVENT_TYPE_VALUES = new Set<string>(Object.values(SecurityEventType));

/**
 * `?eventType=` accepts repeats (`?eventType=A&eventType=B`) and
 * comma-separated lists (`?eventType=A,B`). Every value must name a real
 * `SecurityEventType` — an unknown type is a malformed filter (`400`), not a
 * query that legitimately matches nothing.
 */
function parseEventTypes(raw: unknown): SecurityEventType[] {
  if (raw === undefined) {
    return [];
  }

  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const value of values) {
    if (!EVENT_TYPE_VALUES.has(value)) {
      throw appError(
        400,
        `Unknown event type: ${value}`,
        "event_type_invalid",
      );
    }
  }

  return values as SecurityEventType[];
}

function parseUserIdFilter(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== "string" || !UUID_REGEX.test(value)) {
    throw appError(400, "Invalid user id", "user_id_invalid");
  }

  return value;
}

export interface ManagementListQuery extends SessionListQuery {
  eventType?: unknown;
}

/**
 * A Project's `security_events`, reverse-chronological, keyset-paginated,
 * filterable by event type and by user. Response shape:
 * `{ events: [...], nextCursor: string | null }`.
 */
export async function listProjectEvents(
  projectId: string,
  query: ManagementListQuery,
) {
  const eventTypes = parseEventTypes(query.eventType);
  const userId = parseUserIdFilter(query.userId);
  const limit = parseLimit(query.limit);
  const cursor = decodeCursor(query.cursor);

  const rows = await prisma.securityEvent.findMany({
    where: {
      project_id: projectId,
      ...(eventTypes.length > 0 ? { event_type: { in: eventTypes } } : {}),
      ...(userId ? { user_id: userId } : {}),
      AND: keysetAnd(cursor),
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: EVENT_SELECT,
  });

  const { rows: page, nextCursor } = toPage(rows, limit);

  return { events: page.map(serializeEvent), nextCursor };
}
