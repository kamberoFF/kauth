import type { Server } from "node:http";
import app from "../../app";
import { prisma } from "../../lib/prisma";
import { ensurePlatformProject } from "../../lib/platformProject";
import { clearAllRateLimitKeys } from "../../lib/rateLimitStore";
import { PLATFORM_PROJECT_ID } from "../../constants/platform";

export const TEST_DEVICE_ID = "3f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071";

let server: Server | undefined;
let baseUrl = "";

export async function startTestServer() {
  server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(0, () => resolve(instance));
    instance.on("error", reject);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;

  return baseUrl;
}

export async function stopTestServer() {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }

  await prisma.$disconnect();
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

interface ApiOptions {
  body?: unknown;
  deviceId?: string | null;
  projectId?: string;
  accessToken?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  redirect?: "follow" | "manual" | "error";
}

export async function api<T = any>(
  method: string,
  path: string,
  options: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // These suites drive the bearer contract, so they opt into body tokens.
    // The cookie contract is covered by `cookieClient()` below.
    "x-token-response": "body",
    ...options.headers,
  };

  if (options.deviceId !== null) {
    headers["x-device-id"] = options.deviceId ?? TEST_DEVICE_ID;
  }

  if (options.projectId) {
    headers["x-project-id"] = options.projectId;
  }

  if (options.accessToken) {
    headers["authorization"] = `Bearer ${options.accessToken}`;
  }

  if (options.apiKey) {
    headers["x-api-key"] = options.apiKey;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    redirect: options.redirect,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  // Redirects carry Express's plain-text body, so parsing is conditional.
  const isJson = response.headers
    .get("content-type")
    ?.includes("application/json");

  return {
    status: response.status,
    body: isJson && text.length > 0 ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

interface StoredCookie {
  value: string;
  path: string;
}

/**
 * `fetch` has no cookie jar, so the default `api()` helper can never exercise
 * the cookie contract — it simply never sends one back. This is a deliberately
 * small stand-in for a browser: it honours path scoping, because the refresh
 * cookie being confined to `/refresh` is a property worth testing, and it drops
 * cookies the server expires, because that is how logout is supposed to work.
 */
export function cookieClient() {
  const jar = new Map<string, StoredCookie>();

  function store(header: string) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair?.indexOf("=") ?? -1;

    if (!pair || separator < 0) {
      return;
    }

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();

    const path =
      attributes
        .map((attribute) => attribute.trim().split("="))
        .find(([key]) => key?.toLowerCase() === "path")?.[1] ?? "/";

    const expiry = attributes
      .map((attribute) => attribute.trim().split("="))
      .find(([key]) => key?.toLowerCase() === "expires")?.[1];

    const expired =
      value.length === 0 || (expiry !== undefined && new Date(expiry) <= new Date());

    if (expired) {
      jar.delete(name);
      return;
    }

    jar.set(name, { value, path });
  }

  function header(path: string) {
    const applicable = [...jar.entries()].filter(([, cookie]) =>
      path.startsWith(cookie.path),
    );

    return applicable
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; ");
  }

  return {
    get names() {
      return [...jar.keys()].sort();
    },
    get(name: string) {
      return jar.get(name)?.value;
    },
    /** Fetches a CSRF token so unsafe requests pass the double-submit check. */
    async primeCsrf() {
      const response = await this.request("GET", "/csrf-token");
      return response.body.csrfToken as string;
    },
    async request<T = any>(
      method: string,
      path: string,
      options: ApiOptions & { csrfToken?: string } = {},
    ): Promise<ApiResponse<T>> {
      const cookies = header(path);

      const response = await api<T>(method, path, {
        ...options,
        // A browser stand-in never injects the device header on its own; the
        // jar's kauth_device cookie is the device context. An explicit
        // options.deviceId (header-echo tests) still wins via the spread.
        deviceId: options.deviceId ?? null,
        headers: {
          // Omitted rather than set to "body": this client is standing in for a
          // browser, which must never receive tokens it could store in JS.
          "x-token-response": "",
          ...(cookies ? { cookie: cookies } : {}),
          ...(options.csrfToken ? { "x-csrf-token": options.csrfToken } : {}),
          ...options.headers,
        },
      });

      for (const cookie of response.headers.getSetCookie()) {
        store(cookie);
      }

      return response;
    },
  };
}

/**
 * Truncating projects cascades through every dependent table (users and
 * everything users cascade to), which keeps this from needing to know the
 * full table list as the schema grows. Truncating users alone would miss
 * projects, since projects is upstream of users, not a dependent of it.
 */
export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "projects" RESTART IDENTITY CASCADE',
  );
  // Shared throttle buckets live outside the projects cascade (they key on
  // IPs and project-email pairs), so they are cleared separately — otherwise
  // limits leak across tests even with the NODE_ENV toggle off.
  await clearAllRateLimitKeys();
}

/**
 * A project must be a real seeded row before anything can register into it,
 * so unlike TEST_DEVICE_ID there's no fixed placeholder constant here.
 */
export async function createTestProject(overrides?: { name?: string }) {
  return prisma.project.create({
    data: { name: overrides?.name ?? "Test Project" },
  });
}

/**
 * Register then sign in — the sequence every suite that just wants "a
 * logged-in user in a project" now needs, since register stopped returning a
 * session (`.scratch/register-oracle`, ADR 0008). Returns the sign-in
 * response with a synthesized `user` object (id / email / username / profile
 * read back from the row), so the many call sites that read
 * `body.accessToken` / `body.refreshToken` / `body.user.id` keep working
 * against one place instead of each learning the two-call dance.
 */
export async function registerAndSignIn(
  credentials: { email: string; username: string; password: string },
  projectId: string,
  options: { deviceId?: string | null } = {},
): Promise<ApiResponse> {
  await api("POST", "/register", {
    body: credentials,
    projectId,
    deviceId: options.deviceId,
  });

  const signedIn = await api("POST", "/login", {
    body: { email: credentials.email, password: credentials.password },
    projectId,
    deviceId: options.deviceId,
  });

  const user = await prisma.user.findUnique({
    where: { project_id_email: { project_id: projectId, email: credentials.email } },
    select: {
      id: true,
      email: true,
      username: true,
      email_verified: true,
      first_name: true,
      last_name: true,
    },
  });

  return {
    ...signedIn,
    body: {
      ...signedIn.body,
      user: user
        ? {
            id: user.id,
            email: user.email,
            username: user.username,
            emailVerified: user.email_verified,
            firstName: user.first_name,
            lastName: user.last_name,
          }
        : null,
    },
  };
}

/**
 * The bootstrap flow ticket 03 built (register a developer into the reserved
 * platform project, log in, create a project through the session), reused
 * here since key-issuance/API-key-auth tests need a fresh owned project
 * repeatedly. Each call registers a distinct developer so tests can create
 * two owners for isolation assertions without colliding on email/username.
 */
export async function createOwnedProject(overrides?: { projectName?: string }) {
  await ensurePlatformProject();

  const suffix = crypto.randomUUID();
  const credentials = {
    email: `owner-${suffix}@example.com`,
    username: `owner-${suffix.slice(0, 8)}`,
    password: "correct-horse-battery",
  };

  const developer = await registerAndSignIn(credentials, PLATFORM_PROJECT_ID);

  const created = await api("POST", "/projects", {
    body: { name: overrides?.projectName ?? "Owned Project" },
    accessToken: developer.body.accessToken,
  });

  return {
    project: created.body as { id: string; name: string; ownerId: string },
    developer: {
      userId: developer.body.user.id as string,
      accessToken: developer.body.accessToken as string,
    },
  };
}
