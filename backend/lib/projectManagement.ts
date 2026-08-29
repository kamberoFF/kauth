import { prisma } from "./prisma";
import type { Prisma } from "../generated/prisma/client";
import { SecurityEventType } from "../generated/prisma/enums";
import { UUID_REGEX } from "../constants/regex";
import { appError } from "../utils/errors";
import { decodeCursor, keysetAnd, parseLimit, toPage } from "./pagination";

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
    // actor_user_id, old_role/new_role, apiKeyId) are things a Project owner
    // is entitled to see about their own Project.
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

export interface ManagementListQuery {
  eventType?: unknown;
  userId?: unknown;
  limit?: unknown;
  cursor?: unknown;
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
