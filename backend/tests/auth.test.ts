import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
  TEST_DEVICE_ID,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { generateTokens } from "../lib/jwt";

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

  it("requires a well-formed device header", async () => {
    const absent = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
      deviceId: null,
    });
    expect(absent.status).toBe(400);
    expect(absent.body.error.code).toBe("device_id_missing");

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
    });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeString();
    expect(response.body.refreshToken).toBeString();
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
