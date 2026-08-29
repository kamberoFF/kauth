import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  cookieClient,
  createTestProject,
  registerAndSignIn,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";

const OTHER_DEVICE_ID = "9f8e7d6c-5b4a-4392-8172-6f5e4d3c2b1a";

const credentials = {
  email: "sessions@example.com",
  username: "sessions",
  password: "correct-horse-battery",
};

let project: Awaited<ReturnType<typeof createTestProject>>;

// Register no longer signs the user in (ADR 0008); this does register→login
// and returns the sign-in response with a synthesized `user`.
function registerUser(overrides: Record<string, unknown> = {}) {
  return registerAndSignIn({ ...credentials, ...overrides }, project.id);
}

function listSessions(accessToken: string) {
  return api("GET", "/sessions", { accessToken });
}

function revokeSession(accessToken: string, sessionId: string) {
  return api("DELETE", `/sessions/${sessionId}`, { accessToken });
}

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);
beforeEach(async () => {
  project = await createTestProject();
});

describe("GET /sessions", () => {
  it("requires authentication", async () => {
    const response = await api("GET", "/sessions");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_missing");
  });

  it("lists every active session for the caller across devices", async () => {
    const registered = await registerUser();
    const second = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: OTHER_DEVICE_ID,
      projectId: project.id,
    });

    const response = await listSessions(registered.body.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.sessions).toHaveLength(2);
    const ids = response.body.sessions.map((session: { id: string }) => session.id);
    const sessions = await prisma.session.findMany();
    expect(ids.sort()).toEqual(sessions.map((session) => session.id).sort());
    // second is unused beyond proving a real second session exists.
    expect(second.status).toBe(200);
  });

  it("marks the caller's own session as current", async () => {
    const registered = await registerUser();

    const response = await listSessions(registered.body.accessToken);

    expect(response.body.sessions).toHaveLength(1);
    expect(response.body.sessions[0].current).toBe(true);
  });

  it("excludes a session that was logged out", async () => {
    const registered = await registerUser();
    await api("POST", "/logout", { accessToken: registered.body.accessToken });

    const second = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });

    const response = await listSessions(second.body.accessToken);

    expect(response.body.sessions).toHaveLength(1);
    expect(response.body.sessions[0].current).toBe(true);
  });

  it("never leaks another project's sessions for the same email", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });
    const registered = await registerUser();
    await registerAndSignIn(credentials, otherProject.id);

    const response = await listSessions(registered.body.accessToken);

    expect(response.body.sessions).toHaveLength(1);
  });

  /**
   * Mutation check: temporarily drop `user_id` from the `where` clause in
   * `listSessions` and re-run this test — it must fail, because the caller
   * would then see the other user's session in the same project too.
   * Restore afterward.
   */
  it("never leaks another user's session within the same project", async () => {
    const registered = await registerUser();
    await registerAndSignIn(
      { email: "other@example.com", username: "other", password: credentials.password },
      project.id,
    );

    const response = await listSessions(registered.body.accessToken);

    expect(response.body.sessions).toHaveLength(1);
    expect(response.body.sessions[0].current).toBe(true);
  });

  it("responds with a fixed field whitelist, never internal columns", async () => {
    const registered = await registerUser();

    const response = await listSessions(registered.body.accessToken);
    const [session] = response.body.sessions;

    expect(Object.keys(session).sort()).toEqual(
      [
        "id",
        "current",
        "deviceId",
        "deviceName",
        "deviceType",
        "osName",
        "osVersion",
        "browserName",
        "browserVersion",
        "ipCreated",
        "ipLast",
        "countryCreated",
        "countryLast",
        "cityCreated",
        "cityLast",
        "userAgentCreated",
        "userAgentLast",
        "createdAt",
        "lastUsedAt",
        "expiresAt",
      ].sort(),
    );
  });
});

describe("DELETE /sessions/:sessionId", () => {
  it("requires authentication", async () => {
    const response = await api("DELETE", "/sessions/00000000-0000-4000-8000-000000000000");

    expect(response.status).toBe(401);
  });

  it("revokes a session belonging to the caller", async () => {
    const registered = await registerUser();
    const second = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: OTHER_DEVICE_ID,
      projectId: project.id,
    });

    const target = await prisma.session.findFirstOrThrow({
      where: { device_id: OTHER_DEVICE_ID },
    });

    const response = await revokeSession(registered.body.accessToken, target.id);
    expect(response.status).toBe(200);

    const revoked = await api("GET", "/protected", { accessToken: second.body.accessToken });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe("session_revoked");

    // The caller's own session, untouched by revoking the other device.
    const stillAlive = await api("GET", "/protected", { accessToken: registered.body.accessToken });
    expect(stillAlive.status).toBe(200);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.revoked_reason).toBe("user_revoked");
  });

  it("clears the caller's cookies when revoking their own current session", async () => {
    const client = cookieClient();
    const csrfToken = await client.primeCsrf();
    // Register then sign in through the jar (ADR 0008: register creates no
    // session); the sign-in mints the device cookie and the only session.
    await client.request("POST", "/register", {
      csrfToken,
      body: credentials,
      projectId: project.id,
    });
    await client.request("POST", "/login", {
      csrfToken,
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });

    const session = await prisma.session.findFirstOrThrow({ where: { status: "ACTIVE" } });

    const response = await client.request("DELETE", `/sessions/${session.id}`, { csrfToken });
    expect(response.status).toBe(200);

    expect(client.get("kauth_session")).toBeUndefined();
    expect(client.get("kauth_refresh")).toBeUndefined();

    const stillAuthorized = await client.request("GET", "/protected");
    expect(stillAuthorized.status).toBe(401);
  });

  it("records the revocation in the audit log", async () => {
    const registered = await registerUser();
    const second = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: OTHER_DEVICE_ID,
      projectId: project.id,
    });
    const target = await prisma.session.findFirstOrThrow({ where: { device_id: OTHER_DEVICE_ID } });

    await revokeSession(registered.body.accessToken, target.id);

    const event = await prisma.securityEvent.findFirst({
      where: { event_type: "SESSION_REVOKED", session_id: target.id },
    });
    expect(event).not.toBeNull();
    expect(event!.severity).toBe("WARNING");
    expect(event!.metadata).toMatchObject({ actor: "self" });

    // second is unused beyond ensuring the target row actually exists.
    expect(second.status).toBe(200);
  });

  it("rejects a malformed session id as 400, not 500", async () => {
    const registered = await registerUser();

    const response = await revokeSession(registered.body.accessToken, "not-a-uuid");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("session_id_invalid");
  });

  it("404s on a well-formed but nonexistent session id", async () => {
    const registered = await registerUser();

    const response = await revokeSession(
      registered.body.accessToken,
      "00000000-0000-4000-8000-000000000000",
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("session_not_found");
  });

  /**
   * Mutation check: temporarily drop `user_id` from the where-clause passed to
   * `revokeSessions` in `revokeSession` and re-run this test — it must fail,
   * because the intruder's revoke would then succeed against the victim's
   * session. Restore afterward.
   */
  it("cannot revoke another user's session, even in the same project", async () => {
    const victim = await registerUser();
    const intruder = await registerAndSignIn(
      { email: "intruder@example.com", username: "intruder", password: credentials.password },
      project.id,
    );

    const victimSession = await prisma.session.findFirstOrThrow({
      where: { user_id: victim.body.user.id },
    });

    const response = await revokeSession(intruder.body.accessToken, victimSession.id);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("session_not_found");

    const row = await prisma.session.findUniqueOrThrow({ where: { id: victimSession.id } });
    expect(row.status).toBe("ACTIVE");
  });

  it("cannot reach a session belonging to another project, even for the same email", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });
    await registerUser();
    const otherProjectUser = await registerAndSignIn(credentials, otherProject.id);

    const otherProjectSession = await prisma.session.findFirstOrThrow({
      where: { project_id: otherProject.id },
    });

    const callerFromFirstProject = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });

    const response = await revokeSession(
      callerFromFirstProject.body.accessToken,
      otherProjectSession.id,
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("session_not_found");

    const row = await prisma.session.findUniqueOrThrow({ where: { id: otherProjectSession.id } });
    expect(row.status).toBe("ACTIVE");

    // otherProjectUser is unused beyond seeding the second project's account.
    expect(otherProjectUser.status).toBe(200);
  });
});
