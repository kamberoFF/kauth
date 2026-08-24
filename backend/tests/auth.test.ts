import crypto from "node:crypto";
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
import { prisma } from "../lib/prisma";
import { generateTokens } from "../lib/jwt";
import { INACTIVITY_WINDOW_MS, SESSION_TTL_MS } from "../lib/sessions";
import { UUID_REGEX } from "../constants/regex";

const OTHER_DEVICE_ID = "9f8e7d6c-5b4a-4392-8172-6f5e4d3c2b1a";

const credentials = {
  email: "alice@example.com",
  username: "alice",
  password: "correct-horse-battery",
};

let project: Awaited<ReturnType<typeof createTestProject>>;

function registerUser(overrides: Record<string, unknown> = {}) {
  return api("POST", "/register", {
    body: { ...credentials, ...overrides },
    projectId: project.id,
  });
}

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);
beforeEach(async () => {
  project = await createTestProject();
});

describe("POST /register", () => {
  it("creates a user and issues a token pair", async () => {
    const response = await registerUser();

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe(credentials.email);
    expect(response.body.accessToken).toBeString();
    expect(response.body.refreshToken).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("stores the password hash on a credential account, not on the user", async () => {
    await registerUser();

    const user = await prisma.user.findUniqueOrThrow({
      where: {
        project_id_email: { project_id: project.id, email: credentials.email },
      },
      include: { accounts: true },
    });

    expect(user).not.toHaveProperty("password");
    expect(user.accounts).toHaveLength(1);

    const credential = user.accounts[0]!;
    expect(credential.provider_id).toBe("credential");
    expect(credential.password).not.toBe(credentials.password);
    expect(credential.password?.startsWith("$2")).toBe(true);
  });

  it("starts the account unverified", async () => {
    const response = await registerUser();

    expect(response.body.user.emailVerified).toBe(false);
  });

  it("rejects a duplicate email", async () => {
    await registerUser();
    const response = await registerUser({ username: "someone-else" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("duplicate_email");
  });

  it("rejects a duplicate username without a 500", async () => {
    await registerUser();
    const response = await registerUser({ email: "other@example.com" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("duplicate_username");
  });

  it("rejects invalid input with the shared error contract", async () => {
    const response = await registerUser({ email: "not-an-email" });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      message: "Invalid input",
      code: "validation",
    });
  });

  it("mints a device id when the client supplies none", async () => {
    const response = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
      deviceId: null,
    });

    expect(response.status).toBe(201);
    const minted = response.body.deviceId as string;
    expect(minted).toMatch(UUID_REGEX);

    const session = await prisma.session.findFirstOrThrow({
      where: { user_id: response.body.user.id },
    });
    expect(session.device_id).toBe(minted);
  });

  it("hands the device id to cookie clients via kauth_device", async () => {
    const client = cookieClient();

    const response = await client.request("POST", "/register", {
      body: credentials,
      projectId: project.id,
      deviceId: null,
    });

    expect(response.status).toBe(201);
    expect(client.get("kauth_device")).toBe(response.body.deviceId);
  });

  it("still rejects a malformed device header on register", async () => {
    const malformed = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
      deviceId: "not-a-uuid",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("device_id_invalid");
  });

  it("requires a well-formed project header", async () => {
    const absent = await api("POST", "/register", { body: credentials });
    expect(absent.status).toBe(400);
    expect(absent.body.error.code).toBe("project_id_missing");

    const malformed = await api("POST", "/register", {
      body: credentials,
      headers: { "x-project-id": "not-a-uuid" },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("project_id_invalid");

    const unknown = await api("POST", "/register", {
      body: credentials,
      headers: { "x-project-id": "3f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071" },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("project_not_found");
  });
});

describe("POST /login", () => {
  beforeEach(async () => {
    await registerUser();
  });

  it("issues tokens for valid credentials", async () => {
    const response = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
      deviceId: null,
    });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeString();
    expect(response.body.refreshToken).toBeString();
    expect(response.body.deviceId).toMatch(UUID_REGEX);
  });

  it("mints a fresh device id for a client that lost its old one, leaving other devices' sessions alone", async () => {
    // beforeEach already registered the user on TEST_DEVICE_ID.
    const response = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
      deviceId: null,
    });

    expect(response.status).toBe(200);
    const minted = response.body.deviceId as string;
    expect(minted).toMatch(UUID_REGEX);
    expect(minted).not.toBe(TEST_DEVICE_ID);
    // The minted device matches no prior session, so nothing is replaced —
    // the new login coexists with the registration session instead of
    // silently killing an unrelated browser's session.
    const sessions = await prisma.session.findMany({
      where: { project_id: project.id },
    });
    const byDevice = new Map(sessions.map((s) => [s.device_id, s.status]));
    expect(byDevice.get(TEST_DEVICE_ID)).toBe("ACTIVE");
    expect(byDevice.get(minted)).toBe("ACTIVE");
  });

  it("rejects a wrong password", async () => {
    const response = await api("POST", "/login", {
      body: { email: credentials.email, password: "wrong-password-here" },
      projectId: project.id,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("auth_failed");
  });

  it("rejects an unknown account with the same response as a wrong password", async () => {
    const response = await api("POST", "/login", {
      body: { email: "nobody@example.com", password: credentials.password },
      projectId: project.id,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("auth_failed");
  });

  it("spends comparable time on an unknown account as on a bad password", async () => {
    // The timing oracle this guards: skipping the hash comparison when the
    // account is unknown makes that case return in roughly one DB query,
    // while a real bad-password attempt pays the full hash cost. The
    // threshold is relative so the assertion holds at any machine speed.
    async function timedLogin(body: Record<string, string>) {
      const start = performance.now();
      await api("POST", "/login", { body, projectId: project.id });
      return performance.now() - start;
    }

    // Warm up lazily-built state (connection pool, any one-time setup) so
    // neither side's samples carry first-request costs.
    await timedLogin({
      email: credentials.email,
      password: "wrong-password-here",
    });
    await timedLogin({
      email: "nobody@example.com",
      password: credentials.password,
    });

    const badPassword: number[] = [];
    const unknownAccount: number[] = [];
    for (let i = 0; i < 3; i++) {
      badPassword.push(
        await timedLogin({
          email: credentials.email,
          password: "wrong-password-here",
        }),
      );
      unknownAccount.push(
        await timedLogin({
          email: "nobody@example.com",
          password: credentials.password,
        }),
      );
    }

    const median = (samples: number[]) =>
      samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

    expect(median(unknownAccount)).toBeGreaterThanOrEqual(
      0.5 * median(badPassword),
    );
  });

  it("revokes the previous session for the same device instead of deleting it", async () => {
    await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });

    const sessions = await prisma.session.findMany({
      where: { device_id: TEST_DEVICE_ID },
      orderBy: { created_at: "asc" },
    });

    // The registration session survives as an audit record.
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.status).toBe("REVOKED");
    expect(sessions[0]!.revoked_reason).toBe("replaced_by_new_login");
    expect(sessions[1]!.status).toBe("ACTIVE");
  });
});

describe("POST /refresh", () => {
  async function newSession() {
    const response = await registerUser();
    return response.body.refreshToken as string;
  }

  it("slides the session expiry forward to a full TTL from now", async () => {
    const first = await newSession();
    const session = await prisma.session.findFirstOrThrow({});

    // Age the session so the slide is observable against the original bound.
    await prisma.session.update({
      where: { id: session.id },
      data: { expires_at: new Date(Date.now() + 60_000) },
    });

    const response = await api("POST", "/refresh", {
      body: { refreshToken: first },
    });
    expect(response.status).toBe(200);

    const after = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after.expires_at.getTime()).toBeGreaterThanOrEqual(
      Date.now() + SESSION_TTL_MS - 5_000,
    );
  });

  it("rejects and expires a session idle beyond the inactivity window", async () => {
    const first = await newSession();
    const session = await prisma.session.findFirstOrThrow({});

    // expires_at stays comfortably in the future — inactivity alone kills it.
    await prisma.session.update({
      where: { id: session.id },
      data: { last_used_at: new Date(Date.now() - INACTIVITY_WINDOW_MS - 1) },
    });

    const response = await api("POST", "/refresh", {
      body: { refreshToken: first },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_expired");

    const row = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.status).toBe("EXPIRED");
  });

  it("rotates the refresh token and invalidates the previous one", async () => {
    const first = await newSession();

    const rotated = await api("POST", "/refresh", {
      body: { refreshToken: first },
    });

    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first);

    const replayed = await api("POST", "/refresh", {
      body: { refreshToken: first },
    });

    expect(replayed.status).toBe(401);
  });

  it("records the rotation chain on the consumed token", async () => {
    const first = await newSession();
    const selector = first.split(".")[0];

    await api("POST", "/refresh", { body: { refreshToken: first } });

    const consumed = await prisma.refreshToken.findUniqueOrThrow({
      where: { selector },
    });

    expect(consumed.status).toBe("CONSUMED");
    expect(consumed.consumed_at).not.toBeNull();
    expect(consumed.replaced_by_token_id).not.toBeNull();
  });

  it("revokes the whole family when a consumed token is replayed", async () => {
    const first = await newSession();

    const rotated = await api("POST", "/refresh", {
      body: { refreshToken: first },
    });
    const second = rotated.body.refreshToken as string;

    const replay = await api("POST", "/refresh", {
      body: { refreshToken: first },
    });

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("token_reused");

    const session = await prisma.session.findFirstOrThrow({
      where: { device_id: TEST_DEVICE_ID },
    });
    expect(session.status).toBe("REVOKED");
    expect(session.revoked_reason).toBe("refresh_token_reuse_detected");

    // The token the attacker did not steal must die with the family.
    const afterRevocation = await api("POST", "/refresh", {
      body: { refreshToken: second },
    });
    expect(afterRevocation.status).toBe(401);
  });

  it("rejects a token whose verifier does not match the selector", async () => {
    const first = await newSession();
    const selector = first.split(".")[0];

    const response = await api("POST", "/refresh", {
      body: { refreshToken: `${selector}.forgedverifiervalue` },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_invalid");
  });

  it("rejects an unknown selector", async () => {
    const response = await api("POST", "/refresh", {
      body: { refreshToken: "unknownselector.unknownverifier" },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_invalid");
  });

  it("rejects a malformed token before touching the database", async () => {
    const response = await api("POST", "/refresh", {
      body: { refreshToken: "no-dot-separator" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation");
  });

  it("rejects a token presented from a different device", async () => {
    const first = await newSession();

    const response = await api("POST", "/refresh", {
      body: { refreshToken: first },
      deviceId: OTHER_DEVICE_ID,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("device_mismatch");
  });

  it("does not let a wrong-device presenter expire an idle session", async () => {
    const first = await newSession();
    const session = await prisma.session.findFirstOrThrow({});

    await prisma.session.update({
      where: { id: session.id },
      data: { last_used_at: new Date(Date.now() - INACTIVITY_WINDOW_MS - 1) },
    });

    const response = await api("POST", "/refresh", {
      body: { refreshToken: first },
      deviceId: OTHER_DEVICE_ID,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("device_mismatch");

    // The idle session is left untouched for its rightful device.
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.status).toBe("ACTIVE");
  });

  it("still demands a device context when the client can present neither cookie nor header", async () => {
    const first = await newSession();

    const response = await api("POST", "/refresh", {
      body: { refreshToken: first },
      deviceId: null,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("device_id_missing");
  });
});

describe("cookie transport without an explicit device header", () => {
  it("lets a browser-style client register, refresh, and log out on the minted device id alone", async () => {
    const client = cookieClient();
    const csrf = await client.primeCsrf();

    const registered = await client.request("POST", "/register", {
      body: credentials,
      projectId: project.id,
      deviceId: null,
      csrfToken: csrf,
    });
    expect(registered.status).toBe(201);

    // No x-device-id is ever sent; the jar carries kauth_device alongside
    // the auth cookies. A cookie client receives no body tokens — the rotated
    // refresh token arrives as a replacement cookie.
    const refreshBefore = client.get("kauth_refresh");
    const refreshed = await client.request("POST", "/refresh", {
      csrfToken: csrf,
    });
    expect(refreshed.status).toBe(200);
    expect(client.get("kauth_refresh")).toBeDefined();
    expect(client.get("kauth_refresh")).not.toBe(refreshBefore);

    const loggedOut = await client.request("POST", "/logout", {
      csrfToken: csrf,
    });
    expect(loggedOut.status).toBe(200);
    expect(client.get("kauth_device")).toBeUndefined();
  });
});

describe("POST /logout", () => {
  it("requires an access token", async () => {
    const response = await api("POST", "/logout", {});

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_missing");
  });

  it("ends the session so its refresh token stops working", async () => {
    const registered = await registerUser();

    const response = await api("POST", "/logout", {
      accessToken: registered.body.accessToken,
    });
    expect(response.status).toBe(200);

    const refreshed = await api("POST", "/refresh", {
      body: { refreshToken: registered.body.refreshToken },
    });
    expect(refreshed.status).toBe(401);
  });
});

describe("multi-tenant isolation", () => {
  it("lets the same email register independently in two projects", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });

    const first = await registerUser();
    const second = await api("POST", "/register", {
      body: credentials,
      projectId: otherProject.id,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.user.id).not.toBe(first.body.user.id);
    expect(await prisma.user.count()).toBe(2);
  });

  it("only logs in against the project the account belongs to", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });
    await registerUser();

    const response = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: otherProject.id,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("auth_failed");
  });

  it("rejects an access token from one project against another project's session", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });
    const registered = await registerUser();

    const session = await prisma.session.findFirstOrThrow({
      where: { user_id: registered.body.user.id },
    });

    // A validly signed token whose projectId claim disagrees with the
    // session it names — the direct proof for requireAuth's project check.
    const forged = generateTokens({
      userId: registered.body.user.id,
      familyId: crypto.randomUUID(),
      sessionId: session.id,
      projectId: otherProject.id,
    });

    const response = await api("GET", "/protected", {
      accessToken: forged.accessToken.token,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_invalid");
  });

  it("rotates and revokes refresh tokens independently per project", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });

    const registeredA = await registerUser();
    const registeredB = await api("POST", "/register", {
      body: credentials,
      projectId: otherProject.id,
    });

    // Trigger reuse detection in project A by replaying its rotated token.
    const rotatedA = await api("POST", "/refresh", {
      body: { refreshToken: registeredA.body.refreshToken },
    });
    expect(rotatedA.status).toBe(200);

    const replayA = await api("POST", "/refresh", {
      body: { refreshToken: registeredA.body.refreshToken },
    });
    expect(replayA.status).toBe(401);
    expect(replayA.body.error.code).toBe("token_reused");

    // Project B's identical-email session must be entirely unaffected.
    const rotatedB = await api("POST", "/refresh", {
      body: { refreshToken: registeredB.body.refreshToken },
    });
    expect(rotatedB.status).toBe(200);

    const sessionB = await prisma.session.findFirstOrThrow({
      where: { user_id: registeredB.body.user.id },
    });
    expect(sessionB.status).toBe("ACTIVE");
  });

  it("logs out only the project it was called for", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });

    const registeredA = await registerUser();
    const registeredB = await api("POST", "/register", {
      body: credentials,
      projectId: otherProject.id,
    });

    const logoutResponse = await api("POST", "/logout", {
      accessToken: registeredA.body.accessToken,
    });
    expect(logoutResponse.status).toBe(200);

    const protectedA = await api("GET", "/protected", {
      accessToken: registeredA.body.accessToken,
    });
    expect(protectedA.status).toBe(401);
    expect(protectedA.body.error.code).toBe("session_revoked");

    // Project B's identical-email session must still be usable.
    const protectedB = await api("GET", "/protected", {
      accessToken: registeredB.body.accessToken,
    });
    expect(protectedB.status).toBe(200);
  });
});

describe("session inactivity timeout", () => {
  it("rejects an idle session at the access-token boundary even with future expires_at", async () => {
    const registered = await registerUser();

    const session = await prisma.session.findFirstOrThrow({
      where: { user_id: registered.body.user.id },
    });
    await prisma.session.update({
      where: { id: session.id },
      data: { last_used_at: new Date(Date.now() - INACTIVITY_WINDOW_MS - 1) },
    });

    const response = await api("GET", "/protected", {
      accessToken: registered.body.accessToken,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_expired");
  });

  it("keeps a recently used session alive up to its sliding expiry", async () => {
    const registered = await registerUser();
    const session = await prisma.session.findFirstOrThrow({
      where: { user_id: registered.body.user.id },
    });
    await prisma.session.update({
      where: { id: session.id },
      // Idle for most of the window, but inside it.
      data: { last_used_at: new Date(Date.now() - INACTIVITY_WINDOW_MS / 2) },
    });

    const response = await api("GET", "/protected", {
      accessToken: registered.body.accessToken,
    });

    expect(response.status).toBe(200);
  });
});

describe("error contract", () => {
  it("returns JSON for unknown routes", async () => {
    const response = await api("GET", "/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.body.error.code).toBe("not_found");
  });

  it("rejects an invalid access token", async () => {
    const response = await api("GET", "/protected", {
      accessToken: "not.a.jwt",
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_invalid");
  });
});
