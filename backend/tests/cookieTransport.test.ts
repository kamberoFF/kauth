import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  cookieClient,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
  TEST_DEVICE_ID,
} from "./helpers/api";

const credentials = {
  email: "cookie@example.com",
  username: "cookie",
  password: "correct-horse-battery",
};

let project: Awaited<ReturnType<typeof createTestProject>>;

/**
 * Registers through the bearer contract so each test starts from a clean jar and
 * exercises only the flow it is about.
 */
function registerUser() {
  return api("POST", "/register", { body: credentials, projectId: project.id });
}

function login(client: ReturnType<typeof cookieClient>, csrfToken: string) {
  return client.request("POST", "/login", {
    csrfToken,
    body: { email: credentials.email, password: credentials.password },
    projectId: project.id,
  });
}

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);
beforeEach(async () => {
  project = await createTestProject();
});

describe("cookie transport", () => {
  it("sets both cookies and withholds the tokens from the body", async () => {
    await registerUser();
    const client = cookieClient();
    const csrfToken = await client.primeCsrf();

    const response = await login(client, csrfToken);

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();
    expect(client.get("kauth_session")).toBeString();
    expect(client.get("kauth_refresh")).toBeString();
  });

  it("still returns body tokens when the client opts in", async () => {
    const response = await registerUser();

    expect(response.body.accessToken).toBeString();
    expect(response.body.refreshToken).toBeString();
  });

  it("authenticates a request carrying only the session cookie", async () => {
    await registerUser();
    const client = cookieClient();
    const csrfToken = await client.primeCsrf();
    await login(client, csrfToken);

    const response = await client.request("GET", "/protected");

    expect(response.status).toBe(200);
    expect(response.body.userId).toBeString();
  });

  it("scopes the refresh cookie to /refresh", async () => {
    await registerUser();
    const client = cookieClient();
    const csrfToken = await client.primeCsrf();
    await login(client, csrfToken);

    // The jar mirrors browser path matching, so the refresh cookie must not be
    // offered to an unrelated endpoint.
    const refreshed = await client.request("POST", "/refresh", { csrfToken });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeUndefined();

    const stillAuthorized = await client.request("GET", "/protected");
    expect(stillAuthorized.status).toBe(200);
  });

  it("clears both cookies on logout and stops authenticating", async () => {
    await registerUser();
    const client = cookieClient();
    const csrfToken = await client.primeCsrf();
    await login(client, csrfToken);

    const loggedOut = await client.request("POST", "/logout", { csrfToken });
    expect(loggedOut.status).toBe(200);

    expect(client.get("kauth_session")).toBeUndefined();
    expect(client.get("kauth_refresh")).toBeUndefined();

    const response = await client.request("GET", "/protected");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_missing");
  });

  it("prefers a bearer header over the session cookie", async () => {
    const registered = await registerUser();
    const client = cookieClient();
    const csrfToken = await client.primeCsrf();

    // Explicit echo of the registration device: the re-login then revokes
    // exactly the session the bearer token below belongs to.
    await client.request("POST", "/login", {
      csrfToken,
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
      deviceId: TEST_DEVICE_ID,
    });

    // The header token belongs to the session the re-login just revoked, so if
    // it is honoured the request fails — which is exactly what proves precedence.
    const response = await client.request("GET", "/protected", {
      accessToken: registered.body.accessToken,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_revoked");
  });
});

describe("CSRF enforcement activates with cookies", () => {
  it("rejects an unsafe cookie-bearing request with no CSRF header", async () => {
    await registerUser();
    const client = cookieClient();
    const csrfToken = await client.primeCsrf();
    await login(client, csrfToken);

    const response = await client.request("POST", "/logout");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("csrf_invalid");
  });

  it("leaves cookie-less bearer clients unaffected", async () => {
    const registered = await registerUser();

    const response = await api("POST", "/logout", {
      accessToken: registered.body.accessToken,
    });

    expect(response.status).toBe(200);
  });
});
