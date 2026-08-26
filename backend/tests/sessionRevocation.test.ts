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
import { createMemoryMailer, setMailer } from "../lib/mail";

const OTHER_DEVICE_ID = "9f8e7d6c-5b4a-4392-8172-6f5e4d3c2b1a";

const credentials = {
  email: "revocation@example.com",
  username: "revocation",
  password: "correct-horse-battery",
};

const mailer = createMemoryMailer();

let project: Awaited<ReturnType<typeof createTestProject>>;

function registerUser(overrides: Record<string, unknown> = {}) {
  return api("POST", "/register", {
    body: { ...credentials, ...overrides },
    projectId: project.id,
  });
}

/** Registers, then returns the live access token and its session id. */
async function signIn() {
  const registered = await registerUser();
  const accessToken = registered.body.accessToken as string;
  const refreshToken = registered.body.refreshToken as string;

  const session = await prisma.session.findFirstOrThrow({
    where: { status: "ACTIVE" },
  });

  return { accessToken, refreshToken, sessionId: session.id };
}

function callProtected(accessToken: string) {
  return api("GET", "/protected", { accessToken });
}

function tokenFromLastMail(to: string) {
  const match = mailer.lastTo(to)?.text.match(/token=(\S+)/);

  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

beforeAll(async () => {
  setMailer(mailer);
  await startTestServer();
});

afterAll(async () => {
  setMailer(createMemoryMailer());
  await stopTestServer();
});

beforeEach(async () => {
  await resetDatabase();
  mailer.clear();
  project = await createTestProject();
});

describe("access tokens are bound to their session", () => {
  it("authorizes while the session is active", async () => {
    const { accessToken } = await signIn();

    const response = await callProtected(accessToken);

    expect(response.status).toBe(200);
  });

  it("carries the session id as a claim", async () => {
    const { accessToken, sessionId } = await signIn();

    const [, payload] = accessToken.split(".");
    const claims = JSON.parse(
      Buffer.from(payload!, "base64url").toString("utf8"),
    );

    expect(claims.sid).toBe(sessionId);
  });

  it("rejects a token whose session row is gone", async () => {
    const { accessToken } = await signIn();

    await prisma.session.deleteMany({});

    const response = await callProtected(accessToken);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_invalid");
  });

  it("rejects a token whose subject disagrees with its session", async () => {
    const { sessionId } = await signIn();

    const intruder = await prisma.user.create({
      data: {
        project_id: project.id,
        email: "intruder@example.com",
        username: "intruder",
      },
    });

    // Correctly signed, but minted against someone else's session. Same
    // project as the victim deliberately: this test isolates the userId
    // mismatch path, not the projectId one (that's a separate test in
    // auth.test.ts's multi-tenant isolation suite).
    const { accessToken } = generateTokens({
      userId: intruder.id,
      familyId: crypto.randomUUID(),
      sessionId,
      projectId: project.id,
      role: "USER",
    });

    const response = await callProtected(accessToken.token);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_invalid");
  });

  it("rejects a token whose session has expired", async () => {
    const { accessToken, sessionId } = await signIn();

    await prisma.session.update({
      where: { id: sessionId },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const response = await callProtected(accessToken);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_expired");
  });
});

/**
 * The regression these guard against: before access tokens carried a session
 * claim, every one of these paths revoked the session row and left the bearer
 * token working for the rest of its 15-minute life.
 */
describe("revocation takes effect immediately", () => {
  it("kills the access token on logout", async () => {
    const { accessToken } = await signIn();

    const loggedOut = await api("POST", "/logout", { accessToken });
    expect(loggedOut.status).toBe(200);

    const response = await callProtected(accessToken);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_revoked");
  });

  it("kills the previous access token when the same device logs in again", async () => {
    const { accessToken } = await signIn();

    const relogin = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });
    expect(relogin.status).toBe(200);

    const stale = await callProtected(accessToken);
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe("session_revoked");

    // The replacement session is unaffected.
    const fresh = await callProtected(relogin.body.accessToken);
    expect(fresh.status).toBe(200);
  });

  it("leaves another device's session alone on logout", async () => {
    await registerUser();

    const second = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: OTHER_DEVICE_ID,
      projectId: project.id,
    });

    const first = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: TEST_DEVICE_ID,
      projectId: project.id,
    });

    await api("POST", "/logout", {
      accessToken: first.body.accessToken,
      deviceId: TEST_DEVICE_ID,
    });

    const survivor = await api("GET", "/protected", {
      accessToken: second.body.accessToken,
      deviceId: OTHER_DEVICE_ID,
    });

    expect(survivor.status).toBe(200);
  });

  it("kills the access token on password change", async () => {
    const { accessToken } = await signIn();

    const changed = await api("POST", "/change-password", {
      accessToken,
      body: {
        currentPassword: credentials.password,
        newPassword: "a-brand-new-passphrase",
      },
    });
    expect(changed.status).toBe(200);

    const response = await callProtected(accessToken);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_revoked");
  });

  it("kills the access token on password reset", async () => {
    const { accessToken } = await signIn();

    await api("POST", "/forgot-password", {
      body: { email: credentials.email },
      projectId: project.id,
    });
    const token = tokenFromLastMail(credentials.email)!;

    const reset = await api("POST", "/reset-password", {
      body: { token, password: "another-brand-new-passphrase" },
    });
    expect(reset.status).toBe(200);

    const response = await callProtected(accessToken);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_revoked");
  });

  it("kills the access token when refresh reuse is detected", async () => {
    const { refreshToken } = await signIn();

    const rotated = await api("POST", "/refresh", { body: { refreshToken } });
    expect(rotated.status).toBe(200);

    // Replaying the consumed token is the theft signal that revokes the family.
    const replay = await api("POST", "/refresh", { body: { refreshToken } });
    expect(replay.body.error.code).toBe("token_reused");

    const response = await callProtected(rotated.body.accessToken);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_revoked");
  });
});
