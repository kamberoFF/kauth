import { UUID_REGEX } from "../constants/regex";
import { appError } from "../utils/errors";

/**
 * Keyset (not OFFSET) pagination for the Project-scoped management lists. A
 * busy Project's log stays correct under concurrent writes while an owner
 * pages through it, because each page anchors on the last row it returned
 * rather than a row count that shifts underneath it.
 *
 * Both lists that use this order by `created_at desc, id desc`, so the
 * ordering key is `{ createdAt, id }`.
 */

export interface KeysetCursor {
  createdAt: Date;
  id: string;
}

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

/**
 * `?limit=` clamped to [1, 200]; an unparseable value falls back to the
 * default rather than erroring — a bad page size is not worth a 400.
 */
export function parseLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);

  if (typeof value !== "string" || !Number.isInteger(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

/**
 * The cursor is an opaque base64url blob carrying the ordering key of the last
 * row a page returned. Opaque so a client cannot smuggle in its own predicate;
 * decoded strictly so a tampered one is a clean `400 cursor_invalid`, never a
 * 500 or a silently wrong page.
 */
export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(
    JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }),
  ).toString("base64url");
}

export function decodeCursor(raw: unknown): KeysetCursor | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (value === undefined || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw appError(400, "Invalid pagination cursor", "cursor_invalid");
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { c?: unknown; i?: unknown };

    const createdAt = new Date(String(decoded.c));

    if (
      typeof decoded.i !== "string" ||
      !UUID_REGEX.test(decoded.i) ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error("malformed cursor payload");
    }

    return { createdAt, id: decoded.i };
  } catch {
    throw appError(400, "Invalid pagination cursor", "cursor_invalid");
  }
}

/**
 * The `WHERE (created_at, id) < (cursor.createdAt, cursor.id)` predicate for
 * `ORDER BY created_at desc, id desc`, as an `AND` fragment. Expressed as an
 * OR of two comparisons rather than a row-value comparison because Prisma has
 * no tuple `<`. Returns `[]` (a Prisma no-op) when there is no cursor.
 */
export function keysetAnd(cursor: KeysetCursor | null) {
  if (!cursor) {
    return [];
  }

  return [
    {
      OR: [
        { created_at: { lt: cursor.createdAt } },
        { created_at: cursor.createdAt, id: { lt: cursor.id } },
      ],
    },
  ];
}

/**
 * Turns `limit + 1` fetched rows into a page: whether a next page exists is
 * known only because the query over-fetched by one, and that extra row is
 * dropped before serialization.
 */
export function toPage<T extends { created_at: Date; id: string }>(
  rows: T[],
  limit: number,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { rows, nextCursor: null };
  }

  const page = rows.slice(0, limit);
  const last = page[page.length - 1]!;

  return {
    rows: page,
    nextCursor: encodeCursor({ createdAt: last.created_at, id: last.id }),
  };
}
