import { CONTRACT_VERSION } from "./version";
import { ContractVersionMismatchError, KauthError } from "./errors";

export { CONTRACT_VERSION } from "./version";
export { KauthError, ContractVersionMismatchError } from "./errors";

export interface KauthClientOptions {
  /** Root of the kauth instance, e.g. "https://auth.example.com". */
  baseUrl: string;
  /** A project's publishable key. Safe for browser/mobile bundles. */
  publishableKey: string;
  /**
   * The contract version this integration expects. Defaults to the version
   * this SDK shipped with; override only when pinning deliberately.
   */
  contractVersion?: string;
  /**
   * The server issues and owns device identity: it mints one at session
   * creation, returns it as `deviceId` in the response body (and an
   * HttpOnly cookie for browser clients), and this SDK echoes the captured
   * value on later requests. Pass a persisted value from a previous run so
   * a returning user's new session replaces their old one on the same
   * device; otherwise the first sign-up/sign-in simply mints a fresh one.
   */
  deviceId?: string;
}

export interface KauthUser {
  id: string;
  email: string;
  username: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
}

export interface SignUpInput {
  email: string;
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

/**
 * The tokens live in the SDK's memory and are handed to the host app, which
 * decides how (and whether) to persist them — the platform deliberately never
 * pushes a browser into holding tokens it didn't ask for.
 */
export interface KauthSession {
  user: KauthUser | null;
  accessToken: string;
  refreshToken: string;
}

export type SessionState =
  | { status: "signedOut" }
  | ({ status: "signedIn" } & KauthSession);

export interface SignUpResult {
  user: KauthUser;
  accessToken: string;
  refreshToken: string;
}

export interface KauthClient {
  /**
   * Registers an end user under the publishable key's project and signs them
   * in. Throws the platform's `duplicate_email` / `duplicate_username` /
   * `validation` codes as `KauthError`.
   */
  signUp(input: SignUpInput): Promise<KauthUser>;

  /**
   * Signs an existing end user in. The platform's login endpoint returns
   * tokens without a profile, so the session's `user` is null here; call
   * `signUp`-time data or your own profile endpoint if you need it.
   */
  signIn(input: SignInInput): Promise<void>;

  /**
   * Revokes the current session server-side and clears local state. Resolves
   * immediately when already signed out.
   */
  signOut(): Promise<void>;

  /** Current reactive snapshot; stable reference between transitions. */
  getSnapshot(): SessionState;

  /** Subscribes to state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Creates a browser/mobile-safe kauth client. One instance per app screen
 * tree is typical; all instances created by one call share nothing.
 */
export function createKauthClient({
  baseUrl,
  publishableKey,
  contractVersion = CONTRACT_VERSION,
  deviceId: initialDeviceId,
}: KauthClientOptions): KauthClient {
  const root = baseUrl.replace(/\/+$/, "");

  let state: SessionState = { status: "signedOut" };
  let deviceId = initialDeviceId;
  const listeners = new Set<() => void>();

  function setState(next: SessionState) {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  function assertContractVersion(response: Response) {
    const serverVersion = response.headers.get("x-kauth-contract-version");

    if (serverVersion !== contractVersion) {
      throw new ContractVersionMismatchError(serverVersion, contractVersion);
    }
  }

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-api-key": publishableKey,
        // Omitted until the server has issued a device id for this client;
        // the platform mints one when the header is absent.
        ...(deviceId !== undefined ? { "x-device-id": deviceId } : {}),
        // Native-style transport: tokens come back in the body because this
        // client must work identically in browsers and native apps. The
        // platform still sets its cookies either way.
        "x-token-response": "body",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Checked before anything else, success or failure alike: an exact
    // mismatch invalidates whatever else this response says (ADR 0003).
    assertContractVersion(response);

    const json = await response.json().catch(() => undefined);

    if (!response.ok) {
      throw platformError(response.status, json);
    }

    return json as Record<string, unknown>;
  }

  /** Captures the server-issued device id from a session-creating response. */
  function captureDeviceId(body: Record<string, unknown>) {
    if (typeof body.deviceId === "string" && body.deviceId.length > 0) {
      deviceId = body.deviceId;
    }
  }

  return {
    async signUp(input) {
      const body = await request("POST", "/register", input);
      const result = body as unknown as SignUpResult;
      captureDeviceId(body);

      setState({
        status: "signedIn",
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });

      return result.user;
    },

    async signIn(input) {
      const body = await request("POST", "/login", input);
      captureDeviceId(body);
      const { accessToken, refreshToken } = body as {
        accessToken: string;
        refreshToken: string;
      };

      setState({
        status: "signedIn",
        user: null,
        accessToken,
        refreshToken,
      });
    },

    async signOut() {
      if (state.status !== "signedIn") {
        return;
      }

      const { accessToken } = state;

      try {
        const response = await fetch(`${root}/logout`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(deviceId !== undefined ? { "x-device-id": deviceId } : {}),
            "x-token-response": "body",
            authorization: `Bearer ${accessToken}`,
          },
        });

        assertContractVersion(response);

        // A 401 means the session is already dead server-side — exactly the
        // outcome sign-out wants. Anything else is a real failure to report.
        if (!response.ok && response.status !== 401) {
          throw platformError(response.status, await response.json().catch(() => undefined));
        }
      } finally {
        // The local session is dead the moment we decide to sign out; a
        // network failure reaching the server must not trap the UI in a
        // signed-in view that cannot recover.
        setState({ status: "signedOut" });
      }
    },

    getSnapshot() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function platformError(
  status: number,
  body: unknown,
): KauthError {
  let code = "unknown_error";
  let message = `kauth returned ${status}`;

  const error = (body as { error?: { message?: string; code?: string } })
    ?.error;

  if (error?.code !== undefined) {
    code = error.code;
  }
  if (error?.message !== undefined) {
    message = error.message;
  }

  return new KauthError(code, message);
}
