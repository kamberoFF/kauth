import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { decodeBase32 } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { OAuth2Tokens } from "arctic";
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
import {
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthProfile,
} from "../lib/oauth/providers";
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "../lib/totp";

const credentials = {
  email: "mfa-challenge@example.com",
  username: "mfa-challenge",
  password: "correct-horse-battery",
};

const DEVICE_A = "11111111-2222-4333-8444-555555555555";
const DEVICE_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const PROVIDER_ID = "stub-mfa-challenge";
const VALID_CODE = "valid-authorization-code";

let project: Awaited<ReturnType<typeof createTestProject>>;

let profile: OAuthProfile = {
  accountId: "stub-account-1",
  email: credentials.email,
  emailVerified: true,
  name: "Ada Lovelace",
  image: null,
};

beforeAll(async () => {
  registerOAuthProvider({
    id: PROVIDER_ID,
    scopes: ["email"],
    usesPkce: true,
    createAuthorizationURL: (state, codeVerifier) =>
      new URL(
        `https://provider.example/authorize?state=${state}&code_challenge=${codeVerifier}`,
      ),
    async validateAuthorizationCode(code) {
      if (code !== VALID_CODE) {
        throw new Error("invalid authorization code");
      }

      return new OAuth2Tokens({
        access_token: "stub-access-token",
        token_type: "bearer",
      });
    },
    async fetchProfile() {
      return profile;
    },
  });

  await startTestServer();
});

afterAll(async () => {
  unregisterOAuthProvider(PROVIDER_ID);
  await stopTestServer();
});

beforeEach(async () => {
  await resetDatabase();
  profile = {
    accountId: "stub-account-1",
    email: credentials.email,
    emailVerified: true,
    name: "Ada Lovelace",
    image: null,
  };
  project = await createTestProject();
});

function currentStep() {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
}

function codeFor(secretBase32: string, step: number) {
  return generateHOTP(decodeBase32(secretBase32), BigInt(step), TOTP_DIGITS);
}

async function getUser() {
  // Registration and the OAuth stub both land on this identity; the project
  // scoping keeps the email unique again after each resetDatabase().
  return prisma.user.findUniqueOrThrow({
    where: {
      project_id_email: { project_id: project.id, email: credentials.email },
    },
  });
}

async function registerUser() {
  const registered = await api("POST", "/register", {
    body: credentials,
    projectId: project.id,
  });

  expect(registered.status).toBe(201);

  return registered.body.accessToken as string;
}

/** Registers and walks the full enrollment so tests start from an enrolled
 * user with a known secret and a fresh set of backup codes. */
async function enrollUser() {
  const accessToken = await registerUser();

  const started = await api("POST", "/mfa/enrollment", { accessToken });
  expect(started.status).toBe(200);

  const enrolledAtStep = currentStep();
  const verified = await api("POST", "/mfa/enrollment/verify", {
    accessToken,
    body: { code: codeFor(started.body.secret, enrolledAtStep) },
  });
  expect(verified.status).toBe(200);

  return {
    accessToken,
    secret: started.body.secret as string,
    backupCodes: verified.body.backupCodes as string[],
    // Enrollment records its matched step as last_totp_step, so any later
    // completion must present a strictly newer step to clear the replay guard.
    enrolledAtStep,
  };
}

/**
 * A code guaranteed strictly newer than everything enrollment consumed,
 * while staying inside the ±1 verification window whenever it is submitted:
 * if the clock has not left the enrollment step yet, the forward half of the
 * window covers the next one.
 */
function freshCode(secret: string, enrolledAtStep: number) {
  return codeFor(secret, Math.max(currentStep(), enrolledAtStep + 1));
}

function login(deviceId?: string) {
  return api("POST", "/login", {
    body: { email: credentials.email, password: credentials.password },
    projectId: project.id,
    deviceId,
  });
}

async function challengeFor(deviceId?: string) {
  const response = await login(deviceId);

  expect(response.status).toBe(200);
  expect(response.body.mfaRequired).toBe(true);

  return response.body.challengeToken as string;
}

function submitChallenge(challengeToken: string, code: string, deviceId?: string) {
  // The challenge route derives the project from the token row itself, same
  // as refresh and the OAuth exchange — no x-project-id header involved.
  return api("POST", "/mfa/challenge", {
    body: { challengeToken, code },
    deviceId,
  });
}

describe("phase one: enrolled sign-ins pause at the challenge", () => {
  it("answers an enrolled password login with the 200 challenge shape and no cookies (mutation check: skip the enrolled branch and this test goes red)", async () => {
    await enrollUser();

    const response = await login();

    expect(response.status).toBe(200);
    expect(response.body.mfaRequired).toBe(true);
    expect(response.body.challengeToken).toBeString();
    expect(response.body.challengeToken.length).toBeGreaterThan(0);
    expect(response.body.expiresInSeconds).toBe(300);
    expect(response.body.deviceId).toBe(TEST_DEVICE_ID);

    // Deliberately not an error body and deliberately cookie-free: no session
    // exists yet, so there is nothing to set.
    expect(response.headers.getSetCookie()).toBeEmpty();
    expect(response.body.accessToken).toBeUndefined();

    const stored = await prisma.recoveryToken.findFirstOrThrow({
      where: { token_type: "MFA_CHALLENGE" },
    });
    expect(stored.consumed_at).toBeNull();
    expect(stored.device_id).toBe(TEST_DEVICE_ID);
    expect(stored.project_id).toBe(project.id);
  });

  it("creates no session rows and leaves the prior one alive until phase two", async () => {
    const { accessToken } = await enrollUser();
    const user = await getUser();
    const priorSessions = await prisma.session.findMany({
      where: { user_id: user.id },
    });
    expect(priorSessions).toBeArrayOfSize(1);

    await challengeFor();

    expect(await prisma.session.count({ where: { user_id: user.id } })).toBe(1);
    expect(priorSessions[0]!.status).toBe("ACTIVE");
    // The audit story lives at verify time; issuance stays silent.
    expect(
      await prisma.securityEvent.count({
        where: { user_id: user.id, event_type: "LOGIN_SUCCESS" },
      }),
    ).toBe(0);

    expect(accessToken).toBeString();
  });

  it("keeps unenrolled logins on the single-phase contract", async () => {
    await registerUser();

    const response = await login();

    expect(response.status).toBe(200);
    expect(response.body.mfaRequired).toBeUndefined();
    expect(response.body.accessToken).toBeString();
    expect(await prisma.session.count()).toBeGreaterThanOrEqual(1);
  });

  it("invalidates the previous challenge when reissuing (one live per user)", async () => {
    const { secret, enrolledAtStep } = await enrollUser();

    const first = await challengeFor();
    const second = await challengeFor();

    expect(
      await prisma.recoveryToken.count({
        where: { token_type: "MFA_CHALLENGE", consumed_at: null },
      }),
    ).toBe(1);

    const stale = await submitChallenge(first, codeFor(secret, currentStep()));
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe("token_invalid");

    const fresh = await submitChallenge(second, freshCode(secret, enrolledAtStep));
    expect(fresh.status).toBe(200);
  });
});

describe("POST /mfa/challenge", () => {
  it("completes phase two with body tokens and revokes the replaced session exactly like a normal login", async () => {
    const { secret, enrolledAtStep } = await enrollUser();
    const user = await getUser();
    const priorSession = (
      await prisma.session.findMany({ where: { user_id: user.id } })
    )[0]!;

    const challengeToken = await challengeFor();
    const completed = await submitChallenge(
      challengeToken,
      freshCode(secret, enrolledAtStep),
    );

    expect(completed.status).toBe(200);
    expect(completed.body.accessToken).toBeString();
    expect(completed.body.refreshToken).toBeString();
    expect(completed.body.deviceId).toBe(TEST_DEVICE_ID);

    const replaced = await prisma.session.findUniqueOrThrow({
      where: { id: priorSession.id },
    });
    expect(replaced.revoked_reason).toBe("replaced_by_new_login");

    const active = await prisma.session.findFirstOrThrow({
      where: { user_id: user.id, status: "ACTIVE" },
    });
    expect(active.id).not.toBe(priorSession.id);

    const successEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { user_id: user.id, event_type: "LOGIN_SUCCESS" },
    });
    expect(successEvent.metadata).toMatchObject({ method: "totp" });
    expect(successEvent.session_id).toBe(active.id);

    const authorized = await api("GET", "/protected", {
      accessToken: completed.body.accessToken,
    });
    expect(authorized.status).toBe(200);
  });

  it("burns a consumed challenge: second presentation fails even with a valid code (mutation check: drop the consumed-at guard and this test goes red)", async () => {
    const { secret, enrolledAtStep } = await enrollUser();

    const challengeToken = await challengeFor();
    const usedStep = Math.max(currentStep(), enrolledAtStep + 1);
    const first = await submitChallenge(
      challengeToken,
      codeFor(secret, usedStep),
    );
    expect(first.status).toBe(200);

    // A genuinely fresh code, so only the spent token can explain the reject.
    const replay = await submitChallenge(
      challengeToken,
      codeFor(secret, usedStep + 1),
    );

    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("token_invalid");
    expect(
      await prisma.session.count({ where: { status: "ACTIVE" } }),
    ).toBe(1);
  });

  it("binds the challenge to the device that started phase one (mutation check: remove the device comparison and this test goes red)", async () => {
    const { secret, enrolledAtStep } = await enrollUser();

    const challengeToken = await challengeFor(DEVICE_A);
    // A step the replay guard cannot object to, so only device binding can
    // explain the rejection.
    const code = codeFor(secret, Math.max(currentStep() + 1, enrolledAtStep + 1));

    const wrongDevice = await submitChallenge(challengeToken, code, DEVICE_B);
    expect(wrongDevice.status).toBe(400);
    expect(wrongDevice.body.error.code).toBe("token_invalid");

    // The mismatch must not have spent the token.
    const rightDevice = await submitChallenge(
      challengeToken,
      code,
      DEVICE_A,
    );
    expect(rightDevice.status).toBe(200);
  });

  it("rejects expired and never-issued tokens with the same uniform error", async () => {
    const { secret } = await enrollUser();

    const challengeToken = await challengeFor();
    await prisma.recoveryToken.updateMany({
      where: { token_type: "MFA_CHALLENGE" },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const expired = await submitChallenge(challengeToken, codeFor(secret, currentStep()));
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe("token_invalid");

    const neverIssued = await submitChallenge(
      "never-issued-challenge-token",
      codeFor(secret, currentStep()),
    );
    expect(neverIssued.status).toBe(400);
    expect(neverIssued.body.error.code).toBe("token_invalid");
  });

  it("accepts codes one step old and rejects codes two steps ahead of the window", async () => {
    const { secret } = await enrollUser();
    const user = await getUser();

    // Clear the enrollment's own step so this test isolates window handling
    // from the replay guard (which has its own test below).
    await prisma.user.update({
      where: { id: user.id },
      data: { last_totp_step: null },
    });

    const lagging = await submitChallenge(
      await challengeFor(),
      codeFor(secret, currentStep() - 1),
    );
    expect(lagging.status).toBe(200);

    // Forward half of the window: a code minted for the next step is valid
    // while the clock has not left this one yet.
    const leading = await submitChallenge(
      await challengeFor(),
      codeFor(secret, currentStep() + 1),
    );
    expect(leading.status).toBe(200);

    const ahead = await submitChallenge(
      await challengeFor(),
      codeFor(secret, currentStep() + 2),
    );
    expect(ahead.status).toBe(401);
    expect(ahead.body.error.code).toBe("mfa_code_invalid");
  });


  it("rejects a code at or below the last used step even when still inside the window (mutation check: bypass last_totp_step and this test goes red)", async () => {
    const { secret } = await enrollUser();
    const user = await getUser();

    // Seed a step in the future relative to the code about to be presented:
    // the code is genuinely valid for the current window, so only the replay
    // guard can reject it.
    const futureStep = currentStep() + 5;
    await prisma.user.update({
      where: { id: user.id },
      data: { last_totp_step: futureStep },
    });

    const rejected = await submitChallenge(
      await challengeFor(),
      codeFor(secret, currentStep()),
    );

    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe("mfa_code_invalid");

    const failedEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { user_id: user.id, event_type: "LOGIN_FAILED" },
    });
    expect(failedEvent.metadata).toMatchObject({ reason: "mfa_code_invalid" });
  });

  it("completes with a backup code exactly once, then burns it", async () => {
    const { backupCodes } = await enrollUser();
    const user = await getUser();
    const [firstCode, secondCode] = backupCodes;

    const first = await submitChallenge(
      await challengeFor(),
      firstCode!,
    );
    expect(first.status).toBe(200);

    const successEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { user_id: user.id, event_type: "LOGIN_SUCCESS" },
      orderBy: { created_at: "desc" },
    });
    expect(successEvent.metadata).toMatchObject({ method: "backup_code" });

    const usedEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { user_id: user.id, event_type: "BACKUP_CODE_USED" },
    });
    expect(usedEvent.severity).toBe("WARNING");

    const reuse = await submitChallenge(
      await challengeFor(),
      firstCode!,
    );
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("mfa_code_invalid");

    // A different unused code still works, in any casing the user types.
    if (secondCode) {
      const mangled = secondCode.toLowerCase().replace(/(.{4})/, "$1-");
      const another = await submitChallenge(
        await challengeFor(),
        mangled,
      );
      expect(another.status).toBe(200);
    }
  });

  it("answers a wrong code with 401 mfa_code_invalid, logs LOGIN_FAILED, and keeps the token live within its TTL", async () => {
    const { secret, enrolledAtStep } = await enrollUser();
    const user = await getUser();

    const challengeToken = await challengeFor();
    const wrong = await submitChallenge(challengeToken, "000000");

    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("mfa_code_invalid");

    const failedEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { user_id: user.id, event_type: "LOGIN_FAILED" },
    });
    expect(failedEvent.metadata).toMatchObject({ reason: "mfa_code_invalid" });

    const retry = await submitChallenge(
      challengeToken,
      freshCode(secret, enrolledAtStep),
    );
    expect(retry.status).toBe(200);
  });

  it("validates shape before touching tokens", async () => {
    const missingToken = await api("POST", "/mfa/challenge", {
      body: { code: "123456" },
    });
    expect(missingToken.status).toBe(400);
    expect(missingToken.body.error.code).toBe("validation");

    const missingCode = await api("POST", "/mfa/challenge", {
      body: { challengeToken: "some-token" },
    });
    expect(missingCode.status).toBe(400);
    expect(missingCode.body.error.code).toBe("validation");
  });

  it("works end to end for a cookie browser: no cookies at pause, full jar after phase two", async () => {
    const client = cookieClient();
    const csrfToken = await client.primeCsrf();

    const registered = await client.request("POST", "/register", {
      body: credentials,
      projectId: project.id,
      csrfToken,
    });
    expect(registered.status).toBe(201);

    const started = await client.request("POST", "/mfa/enrollment", { csrfToken });
    expect(started.status).toBe(200);
    const enrolledAtStep = currentStep();
    const verified = await client.request("POST", "/mfa/enrollment/verify", {
      body: { code: codeFor(started.body.secret, enrolledAtStep) },
      csrfToken,
    });
    expect(verified.status).toBe(200);

    const paused = await client.request("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
      csrfToken,
    });
    expect(paused.status).toBe(200);
    expect(paused.body.mfaRequired).toBe(true);
    expect(paused.headers.getSetCookie()).toBeEmpty();
    // The registration session's cookies are untouched, not refreshed.
    expect(client.names).toContain("kauth_session");

    const completed = await client.request("POST", "/mfa/challenge", {
      body: {
        challengeToken: paused.body.challengeToken,
        code: freshCode(started.body.secret, enrolledAtStep),
      },
      csrfToken,
    });
    expect(completed.status).toBe(200);
    expect(completed.body.accessToken).toBeUndefined();

    const status = await client.request("GET", "/mfa");
    expect(status.status).toBe(200);
    expect(status.body.enrolled).toBe(true);
  });
});

describe("phase one over OAuth exchange", () => {
  function cookieHeader(response: { headers: Headers }) {
    return (response.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  }

  async function completeFlow() {
    const started = await api(
      "GET",
      `/oauth/${PROVIDER_ID}?projectId=${project.id}`,
      { redirect: "manual" },
    );
    const state =
      new URL(started.headers.get("location") ?? "").searchParams.get("state") ??
      "";

    const callback = await api(
      "GET",
      `/oauth/${PROVIDER_ID}/callback?code=${VALID_CODE}&state=${state}`,
      { redirect: "manual", headers: { cookie: cookieHeader(started) } },
    );

    return new URL(callback.headers.get("location") ?? "").searchParams.get("code");
  }

  it("challenges an enrolled user at exchange and completes phase two with provider context preserved", async () => {
    const { secret, enrolledAtStep } = await enrollUser();
    const user = await getUser();
    const priorSession = (
      await prisma.session.findMany({ where: { user_id: user.id } })
    )[0]!;

    const code = await completeFlow();
    expect(code).toBeString();

    const exchanged = await api("POST", "/oauth/exchange", { body: { code } });

    expect(exchanged.status).toBe(200);
    expect(exchanged.body.mfaRequired).toBe(true);
    expect(exchanged.body.challengeToken).toBeString();
    expect(exchanged.headers.getSetCookie()).toBeEmpty();
    // No replacement happened at pause time.
    expect(
      await prisma.session.findUniqueOrThrow({ where: { id: priorSession.id } }),
    ).toMatchObject({ status: "ACTIVE" });

    const completed = await submitChallenge(
      exchanged.body.challengeToken,
      freshCode(secret, enrolledAtStep),
    );

    expect(completed.status).toBe(200);
    expect(completed.body.accessToken).toBeString();

    const successEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { user_id: user.id, event_type: "LOGIN_SUCCESS" },
      orderBy: { created_at: "desc" },
    });
    expect(successEvent.metadata).toMatchObject({ method: "totp" });
    expect(successEvent.project_id).toBe(project.id);

    const active = await prisma.session.findFirstOrThrow({
      where: { user_id: user.id, status: "ACTIVE" },
    });
    expect(active.project_id).toBe(project.id);
  });
});
