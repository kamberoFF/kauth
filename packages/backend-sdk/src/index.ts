import { CONTRACT_VERSION } from "./version";
import { ContractVersionMismatchError, KauthError } from "./errors";

export { CONTRACT_VERSION } from "./version";
export { KauthError, ContractVersionMismatchError } from "./errors";

export interface KauthBackendOptions {
  /** Root of the kauth instance, e.g. "https://auth.example.com". */
  baseUrl: string;
  /** A project's secret key. Never ship this in client-side code. */
  secretKey: string;
  /**
   * The contract version this integration expects. Defaults to the version
   * this SDK shipped with; override only when pinning deliberately.
   */
  contractVersion?: string;
}

export interface KauthUser {
  id: string;
  email: string;
  username: string;
  emailVerified: boolean;
  role: string;
  createdAt: string;
}

export interface VerifiedSession {
  id: string;
  userId: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

/** One page of a cursor-paginated list. `nextCursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * A session in the calling project's Project-wide session list. Every session
 * list in kauth is ACTIVE-only; revocation history lives in the event log.
 */
export interface KauthSessionSummary {
  id: string;
  userId: string;
  status: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceType: string | null;
  osName: string | null;
  osVersion: string | null;
  browserName: string | null;
  browserVersion: string | null;
  ipCreated: string | null;
  ipLast: string | null;
  countryCreated: string | null;
  countryLast: string | null;
  cityCreated: string | null;
  cityLast: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

/**
 * One row of the calling project's security-event log. `metadata` is returned
 * exactly as the platform stored it — never tokens, hashes, or credentials
 * (a platform invariant), but identifiers a Project owner is entitled to see.
 */
export interface KauthSecurityEvent {
  id: string;
  eventType: string;
  severity: string;
  userId: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ListSessionsOptions {
  /** Narrow to one user's sessions. */
  userId?: string;
  /** Page size, clamped server-side to 1–200 (default 50). */
  limit?: number;
  /** The `nextCursor` from a previous page. */
  cursor?: string;
}

export interface ListEventsOptions {
  /** One event type or several; each must name a real `SecurityEventType`. */
  eventType?: string | string[];
  /** Narrow to events about one user. */
  userId?: string;
  /** Page size, clamped server-side to 1–200 (default 50). */
  limit?: number;
  /** The `nextCursor` from a previous page. */
  cursor?: string;
}

interface RawSession {
  id: string;
  userId: string;
  status: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * The body `PATCH /projects/:projectId` accepts, typed for integrations that
 * drive project settings through an owner's session (the route is
 * session-authenticated and deliberately never reachable by this package's
 * secret key). Keys are the wire format the platform validates — snake_case,
 * like every settings payload. Partial-update semantics: an absent field is
 * left untouched, and an explicit `null` clears back to the deployment
 * default.
 */
export interface UpdateProjectSettingsInput {
  /** Password floor (8–128); null falls back to `PASSWORD_MIN_LENGTH`. */
  min_password_length?: number | null;
  /**
   * Whether every User must enroll a second factor. Turning this on grants
   * each unenrolled user a grace window immediately.
   */
  enforce_mfa?: boolean;
  /**
   * Length of that grace window in days. Accepted only inside the 3–90
   * range — out-of-range values are rejected with `validation`, not silently
   * adjusted, because a quietly shortened or lengthened lockout window is a
   * policy decision an owner should have to state correctly. Null means the
   * deployment default of 7 days.
   */
  mfa_grace_days?: number | null;
}

export interface KauthBackend {
  /**
   * Confirms a session is live *right now* — every call is a network call
   * against the platform's own database, so a session revoked moments ago
   * (logout, password change, reuse detection) reads as inactive immediately.
   * Throws with code `session_inactive` for a known-but-dead session and the
   * platform's `session_not_found` for one that does not exist in the calling
   * project.
   */
  verifySession(sessionId: string): Promise<VerifiedSession>;

  /** The calling project's own end users — never another project's. */
  listUsers(): Promise<KauthUser[]>;

  /** Revokes any ACTIVE session belonging to the calling project. */
  revokeSession(sessionId: string): Promise<void>;

  /**
   * The calling project's ACTIVE sessions, reverse-chronological and
   * cursor-paginated — never another project's. Pass `nextCursor` back as
   * `cursor` to walk subsequent pages.
   */
  listSessions(options?: ListSessionsOptions): Promise<Page<KauthSessionSummary>>;

  /**
   * The calling project's security-event log, reverse-chronological and
   * cursor-paginated — logins, failures, password resets, MFA changes, key
   * issuance/revocation. Scoped to the key's own Project.
   */
  listEvents(options?: ListEventsOptions): Promise<Page<KauthSecurityEvent>>;
}

/**
 * Creates a backend kauth client. One instance per project secret key; safe to
 * reuse across requests.
 */
export function createKauthBackend({
  baseUrl,
  secretKey,
  contractVersion = CONTRACT_VERSION,
}: KauthBackendOptions): KauthBackend {
  const root = baseUrl.replace(/\/+$/, "");

  function assertContractVersion(response: Response) {
    const serverVersion = response.headers.get("x-kauth-contract-version");

    if (serverVersion !== contractVersion) {
      throw new ContractVersionMismatchError(serverVersion, contractVersion);
    }
  }

  async function request(
    method: string,
    path: string,
    query?: Record<string, string | string[] | number | undefined>,
  ): Promise<unknown> {
    const url = new URL(`${root}${path}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) {
        continue;
      }
      for (const entry of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(entry));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        "x-api-key": secretKey,
        accept: "application/json",
      },
    });

    // Checked before anything else, success or failure alike: an exact
    // mismatch invalidates whatever else this response says (ADR 0003).
    assertContractVersion(response);

    if (!response.ok) {
      throw await platformError(response);
    }

    return response.status === 204 ? undefined : response.json();
  }

  return {
    async verifySession(sessionId) {
      const session = (await request(
        "GET",
        `/project/sessions/${sessionId}`,
      )) as RawSession;

      // Expiry is written lazily server-side — a session past its expires_at
      // can still carry status ACTIVE until something touches it — so the
      // clock is checked here as well as the status.
      const expired = new Date(session.expiresAt).getTime() <= Date.now();

      if (session.status !== "ACTIVE" || expired) {
        throw new KauthError(
          "session_inactive",
          `Session ${session.id} is not active`,
        );
      }

      return {
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
      };
    },

    async listUsers() {
      const body = (await request("GET", "/project/users")) as {
        users: KauthUser[];
      };

      return body.users;
    },

    async revokeSession(sessionId) {
      await request("DELETE", `/project/sessions/${sessionId}`);
    },

    async listSessions(options = {}) {
      const body = (await request("GET", "/project/sessions", {
        userId: options.userId,
        limit: options.limit,
        cursor: options.cursor,
      })) as { sessions: KauthSessionSummary[]; nextCursor: string | null };

      return { items: body.sessions, nextCursor: body.nextCursor };
    },

    async listEvents(options = {}) {
      const body = (await request("GET", "/project/events", {
        eventType: options.eventType,
        userId: options.userId,
        limit: options.limit,
        cursor: options.cursor,
      })) as { events: KauthSecurityEvent[]; nextCursor: string | null };

      return { items: body.events, nextCursor: body.nextCursor };
    },
  };
}

async function platformError(response: Response): Promise<KauthError> {
  let code = "unknown_error";
  let message = `kauth returned ${response.status}`;

  try {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };

    if (body.error?.code !== undefined) {
      code = body.error.code;
    }
    if (body.error?.message !== undefined) {
      message = body.error.message;
    }
  } catch {
    // Non-JSON error body: keep the status-line fallbacks above.
  }

  return new KauthError(code, message);
}
