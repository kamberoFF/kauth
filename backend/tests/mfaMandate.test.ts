import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { decodeBase32 } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { OAuth2Tokens } from "arctic";
import {
  api,
  createOwnedProject,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
  TEST_DEVICE_ID,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { ensurePlatformProject } from "../lib/platformProject";
import { MFA_GRACE_DAYS_DEFAULT } from "../lib/mfaPolicy";
import {
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthProfile,
} from "../lib/oauth/providers";
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "../lib/totp";

/**
 * Ticket 05 — project mandate with grace. Sign-in is never blocked; the
 * mandate walls usage in requireAuth once a per-user grace window lapses.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP_TOLERANCE_MS = 60_000;

const PROVIDER_ID = "stub";
const VALID_CODE = "valid-authorization-code";

const profile: OAuthProfile = {
  accountId: "stub-account-1",
  email: "social@example.com",
  emailVerified: true,
  name: "Ada Lovelace",
  image: "https://example.com/avatar.png",
};

let project: Awaited<ReturnType<typeof createTestProject>>;

function currentStep() {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
}

function codeFor(secretBase32: string, step: number) {
  return generateHOTP(decodeBase32(secretBase32), BigInt(step), TOTP_DIGITS);
}

/** The stamp must be an ISO string sitting ~`days` out from now. */
function expectDeadlineNear(iso: unknown, days: number) {
  expect(iso).toBeString();

  const delta = new Date(iso as string).getTime() - Date.now();
  expect(Math.abs(delta - days * DAY_MS)).toBeLessThan(STAMP_TOLERANCE_MS);
}

async function mandateProject(
  overrides: { mfa_grace_days?: number } = {},
) {
  await prisma.project.update({
    where: { id: project.id },
    data: { enforce_mfa: true, ...overrides },
  });
}

async function getUserByEmail(email: string) {
  return prisma.user.findUniqueOrThrow({
    where: { project_id_email: { project_id: project.id, email } },
  });
}

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
  await ensurePlatformProject();
  project = await createTestProject();
});

describe("PATCH /projects/:id mandate settings", () => {
  it("lets the owner activate the mandate and records the policy change", async () => {
    const { project: owned, developer } = await createOwnedProject();

    const response = await api("PATCH", `/projects/${owned.id}`, {
      accessToken: developer.accessToken,
      body: { enforce_mfa: true },
    });

    expect(response.status).toBe(200);
    expect(response.body.enforceMfa).toBe(true);
    expect(response.body.mfaGraceDays).toBeNull();

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "PROJECT_MFA_POLICY_CHANGED" },
    });
    expect(event.severity).toBe("WARNING");
    expect(event.project_id).toBe(owned.id);
    expect(event.user_id).toBe(developer.userId);
    expect(event.metadata).toMatchObject({ enforce_mfa: true });
  });

  it("stores and clears mfa_grace_days within the clamp, auditing each change", async () => {
    const { project: owned, developer } = await createOwnedProject();

    const set = await api("PATCH", `/projects/${owned.id}`, {
      accessToken: developer.accessToken,
      body: { mfa_grace_days: 30 },
    });
    expect(set.status).toBe(200);
    expect(set.body.mfaGraceDays).toBe(30);

    const cleared = await api("PATCH", `/projects/${owned.id}`, {
      accessToken: developer.accessToken,
      body: { mfa_grace_days: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.mfaGraceDays).toBeNull();

    const events = await prisma.securityEvent.findMany({
      where: { event_type: "PROJECT_MFA_POLICY_CHANGED" },
      orderBy: { created_at: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.metadata).toMatchObject({ mfa_grace_days: 30 });
    expect(events[1]!.metadata).toMatchObject({ mfa_grace_days: null });
  });

  it("rejects out-of-clamp and malformed grace days without changing state", async () => {
    const { project: owned, developer } = await createOwnedProject();

    for (const mfa_grace_days of [2, 91, 3.5, "ten"]) {
      const response = await api("PATCH", `/projects/${owned.id}`, {
        accessToken: developer.accessToken,
        body: { mfa_grace_days },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation");
    }

    expect(await prisma.project.findUniqueOrThrow({ where: { id: owned.id } }))
      .toMatchObject({ enforce_mfa: false, mfa_grace_days: null });
    expect(
      await prisma.securityEvent.count({
        where: { event_type: "PROJECT_MFA_POLICY_CHANGED" },
      }),
    ).toBe(0);
  });

  it("answers a non-owner with the same 404 as a missing project", async () => {
    const target = await createOwnedProject();
    const stranger = await createOwnedProject();

    const response = await api("PATCH", `/projects/${target.project.id}`, {
      accessToken: stranger.developer.accessToken,
      body: { enforce_mfa: true },
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");
  });

  it("does not record a policy event when nothing flips", async () => {
    const { project: owned, developer } = await createOwnedProject();

    const response = await api("PATCH", `/projects/${owned.id}`, {
      accessToken: developer.accessToken,
      body: { enforce_mfa: false },
    });

    expect(response.status).toBe(200);
    expect(
      await prisma.securityEvent.count({
        where: { event_type: "PROJECT_MFA_POLICY_CHANGED" },
      }),
    ).toBe(0);
  });

  it("records the event when the owner deactivates the mandate", async () => {
    const { project: owned, developer } = await createOwnedProject();

    const activated = await api("PATCH", `/projects/${owned.id}`, {
      accessToken: developer.accessToken,
      body: { enforce_mfa: true },
    });
    expect(activated.status).toBe(200);

    const deactivated = await api("PATCH", `/projects/${owned.id}`, {
      accessToken: developer.accessToken,
      body: { enforce_mfa: false },
    });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.enforceMfa).toBe(false);

    const events = await prisma.securityEvent.findMany({
      where: { event_type: "PROJECT_MFA_POLICY_CHANGED" },
      orderBy: { created_at: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(events[1]!.metadata).toMatchObject({ enforce_mfa: false });
  });
});

describe("grace stamping at sign-in", () => {
  it("stamps a fresh registration with the default window and surfaces the deadline", async () => {
    await mandateProject();

    const response = await api("POST", "/register", {
      body: {
        email: "stamped@example.com",
        username: "stamped",
        password: "correct-horse-battery",
      },
      projectId: project.id,
    });

    expect(response.status).toBe(201);
    expectDeadlineNear(response.body.mfaGraceEndsAt, MFA_GRACE_DAYS_DEFAULT);

    const user = await getUserByEmail("stamped@example.com");
    expect(user.mfa_grace_ends_at!.getTime()).toBe(
      new Date(response.body.mfaGraceEndsAt).getTime(),
    );
  });

  it("honors a project-configured window length", async () => {
    await mandateProject({ mfa_grace_days: 30 });

    const response = await api("POST", "/register", {
      body: {
        email: "thirty@example.com",
        username: "thirty",
        password: "correct-horse-battery",
      },
      projectId: project.id,
    });

    expectDeadlineNear(response.body.mfaGraceEndsAt, 30);
  });

  it("leaves no stamp and no response field without a mandate", async () => {
    const response = await api("POST", "/register", {
      body: {
        email: "unmandated@example.com",
        username: "unmandated",
        password: "correct-horse-battery",
      },
      projectId: project.id,
    });

    expect(response.status).toBe(201);
    expect(response.body.mfaGraceEndsAt).toBeUndefined();

    const user = await getUserByEmail("unmandated@example.com");
    expect(user.mfa_grace_ends_at).toBeNull();
  });

  it("never shortens an existing window on a second sign-in", async () => {
    await mandateProject({ mfa_grace_days: 30 });

    const credentials = {
      email: "twice@example.com",
      username: "twice",
      password: "correct-horse-battery",
    };
    await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });
    // A deadline already partly spent must survive the next sign-in intact.
    const spent = new Date(Date.now() + 5 * DAY_MS);
    await prisma.user.update({
      where: { id: (await getUserByEmail(credentials.email)).id },
      data: { mfa_grace_ends_at: spent },
    });

    const loggedIn = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });

    expect(loggedIn.status).toBe(200);
    expect(new Date(loggedIn.body.mfaGraceEndsAt as string).getTime()).toBe(
      spent.getTime(),
    );

    const user = await getUserByEmail(credentials.email);
    expect(user.mfa_grace_ends_at!.getTime()).toBe(spent.getTime());
  });

  it("omits the field for an enrolled user's phase-one challenge response", async () => {
    await mandateProject();

    const credentials = {
      email: "enrolled@example.com",
      username: "enrolled",
      password: "correct-horse-battery",
    };
    const registered = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });

    const started = await api("POST", "/mfa/enrollment", {
      accessToken: registered.body.accessToken,
    });
    const verified = await api("POST", "/mfa/enrollment/verify", {
      accessToken: registered.body.accessToken,
      body: { code: codeFor(started.body.secret, currentStep()) },
    });
    expect(verified.status).toBe(200);

    const challenge = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });

    expect(challenge.status).toBe(200);
    expect(challenge.body.mfaRequired).toBe(true);
    expect(challenge.body.mfaGraceEndsAt).toBeUndefined();
  });

  it("surfaces the deadline on an OAuth exchange that creates a session", async () => {
    await mandateProject();

    async function completeFlow() {
      const started = await api(
        "GET",
        `/oauth/${PROVIDER_ID}?projectId=${project.id}`,
        { redirect: "manual" },
      );
      const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const cookie = (started.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(";")[0])
        .join("; ");

      const callback = await api(
        "GET",
        `/oauth/${PROVIDER_ID}/callback?code=${VALID_CODE}&state=${state}`,
        { redirect: "manual", headers: { cookie } },
      );

      return new URL(callback.headers.get("location") ?? "").searchParams.get("code");
    }

    const code = await completeFlow();
    expect(code).toBeString();

    const exchanged = await api("POST", "/oauth/exchange", {
      body: { code },
      deviceId: TEST_DEVICE_ID,
    });

    expect(exchanged.status).toBe(200);
    expectDeadlineNear(exchanged.body.mfaGraceEndsAt, MFA_GRACE_DAYS_DEFAULT);

    const user = await getUserByEmail("social@example.com");
    expect(user.mfa_grace_ends_at).not.toBeNull();
  });
});

describe("the requireAuth wall", () => {
  const credentials = {
    email: "walled@example.com",
    username: "walled",
    password: "correct-horse-battery",
  };

  async function registerWalled() {
    const registered = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });

    expect(registered.status).toBe(201);

    return registered.body.accessToken as string;
  }

  /** Registers under an active mandate, then fast-forwards the user's window
   * into the past — the state every walled session below starts from. */
  async function pastDeadlineUser() {
    await mandateProject();
    const accessToken = await registerWalled();

    await prisma.user.updateMany({
      where: { project_id: project.id },
      data: { mfa_grace_ends_at: new Date(Date.now() - DAY_MS) },
    });

    return accessToken;
  }

  async function enrollWith(accessToken: string) {
    const started = await api("POST", "/mfa/enrollment", { accessToken });
    expect(started.status).toBe(200);

    const verified = await api("POST", "/mfa/enrollment/verify", {
      accessToken,
      body: { code: codeFor(started.body.secret, currentStep()) },
    });
    expect(verified.status).toBe(200);

    return started.body.secret as string;
  }

  it("walls every non-exempt route once the grace deadline passes", async () => {
    const accessToken = await pastDeadlineUser();

    const sessions = await api("GET", "/sessions", { accessToken });
    expect(sessions.status).toBe(403);
    expect(sessions.body.error.code).toBe("mfa_enrollment_required");

    const changePassword = await api("POST", "/change-password", {
      accessToken,
      body: {
        currentPassword: credentials.password,
        newPassword: "another-good-password",
      },
    });
    expect(changePassword.status).toBe(403);
    expect(changePassword.body.error.code).toBe("mfa_enrollment_required");
  });

  it("keeps self-service alive inside the wall: /mfa routes and logout", async () => {
    const accessToken = await pastDeadlineUser();

    const status = await api("GET", "/mfa", { accessToken });
    expect(status.status).toBe(200);
    expect(status.body.enrolled).toBe(false);
    expect(status.body.graceEndsAt).toBeString();

    // Not 200 — the user is unenrolled — but decisively not the wall either.
    const disable = await api("DELETE", "/mfa", {
      accessToken,
      body: { password: credentials.password, code: "123456" },
    });
    expect(disable.status).toBe(409);
    expect(disable.body.error.code).toBe("mfa_not_enrolled");

    const logout = await api("POST", "/logout", { accessToken });
    expect(logout.status).toBe(200);
  });

  it("answers 403 mfa_enrollment_required across every non-exempt route", async () => {
    const { project: owned } = await createOwnedProject();
    const accessToken = await pastDeadlineUser();

    // A representative sweep of the requireAuth-gated surface: sessions,
    // account, project management, and the bare protected endpoint.
    const routes: [string, string][] = [
      ["GET", "/sessions"],
      ["GET", "/accounts"],
      ["POST", "/change-password"],
      ["GET", `/projects/${owned.id}/keys`],
      ["GET", "/protected"],
    ];

    for (const [method, path] of routes) {
      const response = await api(method, path, { accessToken });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("mfa_enrollment_required");
    }
  });

  it("lets a walled user enroll out of the wall end-to-end", async () => {
    const accessToken = await pastDeadlineUser();

    await enrollWith(accessToken);

    // Enrolling clears the grace stamp: an enrolled user no longer owes one.
    const user = await getUserByEmail(credentials.email);
    expect(user.mfa_enrolled_at).not.toBeNull();
    expect(user.mfa_grace_ends_at).toBeNull();

    const sessions = await api("GET", "/sessions", { accessToken });
    expect(sessions.status).toBe(200);
  });

  it("leaves in-grace sessions fully working", async () => {
    await mandateProject();
    const accessToken = await registerWalled();

    const sessions = await api("GET", "/sessions", { accessToken });
    expect(sessions.status).toBe(200);
  });

  it("walls an unenrolled user with no stamp at all under an active policy", async () => {
    await mandateProject();
    const accessToken = await registerWalled();

    // Entry points always stamp; a missing stamp means the enrollment was
    // wiped after the fact (disable/reset), and the mandate must not be
    // dodgeable by clearing it.
    await prisma.user.updateMany({
      where: { project_id: project.id },
      data: { mfa_grace_ends_at: null },
    });

    const sessions = await api("GET", "/sessions", { accessToken });
    expect(sessions.status).toBe(403);
    expect(sessions.body.error.code).toBe("mfa_enrollment_required");
  });

  it("walls immediately when enrolled MFA is disabled while the mandate is active", async () => {
    await mandateProject();
    const accessToken = await registerWalled();

    const secret = await enrollWith(accessToken);
    const enrolledAtStep = currentStep();

    const disabled = await api("DELETE", "/mfa", {
      accessToken,
      body: {
        password: credentials.password,
        code: codeFor(secret, Math.max(currentStep(), enrolledAtStep + 1)),
      },
    });
    expect(disabled.status).toBe(200);

    // Disabling clears the stamp and the enrollment; with the mandate still
    // on there is no fresh grace for a session that already had its chance.
    const sessions = await api("GET", "/sessions", { accessToken });
    expect(sessions.status).toBe(403);
    expect(sessions.body.error.code).toBe("mfa_enrollment_required");
  });

  it("is inert when the mandate is off, stale stamps included", async () => {
    const accessToken = await registerWalled();

    await prisma.user.updateMany({
      where: { project_id: project.id },
      data: { mfa_grace_ends_at: new Date(Date.now() - DAY_MS) },
    });

    const sessions = await api("GET", "/sessions", { accessToken });
    expect(sessions.status).toBe(200);
  });

  it("issues exactly one query per authenticated request", async () => {
    const accessToken = await pastDeadlineUser();

    const delegate = prisma.session as unknown as {
      findUnique: unknown;
    };
    const original = delegate.findUnique;
    let calls = 0;
    let capturedArgs: unknown;

    (delegate as { findUnique: unknown }).findUnique = (
      ...args: unknown[]
    ) => {
      calls += 1;
      capturedArgs = args[0];
      return (
        original as (...callArgs: unknown[]) => Promise<unknown>
      )(...args);
    };

    try {
      const response = await api("GET", "/protected", { accessToken });

      // The mandate is active and the deadline has passed, so this request
      // exercises the full wall path on its way out.
      expect(response.status).toBe(403);
    } finally {
      (delegate as { findUnique: unknown }).findUnique = original;
    }

    expect(calls).toBe(1);
    expect(capturedArgs).toHaveProperty("select.user.select.mfa_enrolled_at");
    expect(capturedArgs).toHaveProperty("select.project.select.enforce_mfa");
  });
});
