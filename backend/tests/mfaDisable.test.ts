import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { decodeBase32 } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { CREDENTIAL_PROVIDER } from "../constants/providers";
import { createMemoryMailer, setMailer } from "../lib/mail";
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "../lib/totp";

interface TestUser {
  email: string;
  username: string;
  password: string;
}

const baseUser: TestUser = {
  email: "mfa-disable@example.com",
  username: "mfa-disable",
  password: "correct-horse-battery",
};

function userFor(suffix: string): TestUser {
  return {
    email: `mfa-disable-${suffix}@example.com`,
    username: `mfa-disable-${suffix}`,
    password: baseUser.password,
  };
}

const mailer = createMemoryMailer();

let project: Awaited<ReturnType<typeof createTestProject>>;

function currentStep() {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
}

function codeFor(secretBase32: string, step: number) {
  return generateHOTP(decodeBase32(secretBase32), BigInt(step), TOTP_DIGITS);
}

async function getUser(user: TestUser) {
  return prisma.user.findUniqueOrThrow({
    where: {
      project_id_email: { project_id: project.id, email: user.email },
    },
  });
}

async function registerUser(user: TestUser) {
  const registered = await api("POST", "/register", {
    body: user,
    projectId: project.id,
  });

  expect(registered.status).toBe(201);

  return registered.body.accessToken as string;
}

/** Registers and walks the full enrollment so tests start from an enrolled
 * user with a known secret and a fresh set of backup codes. */
async function enrollUser(user: TestUser) {
  const accessToken = await registerUser(user);

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
    user,
    secret: started.body.secret as string,
    backupCodes: verified.body.backupCodes as string[],
    // Enrollment records its matched step as last_totp_step, so a later
    // disable must present a strictly newer step to clear the replay guard.
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

function disableMfa(accessToken: string, password: string, code: string) {
  return api("DELETE", "/mfa", { accessToken, body: { password, code } });
}

async function mfaSnapshot(userId: string) {
  const state = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      totp_secret: true,
      mfa_enrolled_at: true,
      last_totp_step: true,
      mfa_grace_ends_at: true,
    },
  });
  const codes = await prisma.mfaBackupCode.findMany({
    where: { user_id: userId },
    select: { id: true, used_at: true },
  });
  const disabledEvents = await prisma.securityEvent.findMany({
    where: { user_id: userId, event_type: "MFA_DISABLED" },
  });

  return { state, codes, disabledEvents };
}

beforeAll(async () => {
  setMailer(mailer);
  await startTestServer();
});

afterAll(async () => {
  // A fresh in-memory transport, not the console one: other suites share this
  // process and would otherwise start printing their mail.
  setMailer(createMemoryMailer());
  await stopTestServer();
});

beforeEach(async () => {
  await resetDatabase();
  mailer.clear();
  project = await createTestProject();
});

describe("DELETE /mfa", () => {
  it("requires authentication", async () => {
    const response = await disableMfa("", baseUser.password, "123456");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_missing");
  });

  it("disables fully with both proofs and keeps sessions alive", async () => {
    const enrolled = await enrollUser(baseUser);
    const row = await getUser(baseUser);
    const sessionBefore = await prisma.session.findFirstOrThrow({
      where: { user_id: row.id },
    });

    const response = await disableMfa(
      enrolled.accessToken,
      baseUser.password,
      freshCode(enrolled.secret, enrolled.enrolledAtStep),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});

    const status = await api("GET", "/mfa", { accessToken: enrolled.accessToken });
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ enrolled: false });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.totp_secret).toBeNull();
    expect(after.mfa_enrolled_at).toBeNull();
    expect(after.last_totp_step).toBeNull();
    expect(after.mfa_grace_ends_at).toBeNull();

    // Codes die with the enrollment — no hash survives the wipe.
    expect(
      await prisma.mfaBackupCode.count({ where: { user_id: row.id } }),
    ).toBe(0);

    // No credential changed, so no session had to die. The very token that
    // performed the disable keeps working (asserted via GET /mfa above).
    const sessionAfter = await prisma.session.findUniqueOrThrow({
      where: { id: sessionBefore.id },
    });
    expect(sessionAfter.status).toBe("ACTIVE");
    expect(await prisma.session.count({ where: { user_id: row.id } })).toBe(1);

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { user_id: row.id, event_type: "MFA_DISABLED" },
    });
    expect(event.severity).toBe("WARNING");
    expect(event.metadata).toEqual({ reason: "user_initiated" });
    expect(event.project_id).toBe(project.id);
  });

  it("rejects a wrong password with auth_failed and mutates nothing (mutation check: remove the password verification and this test goes red)", async () => {
    const enrolled = await enrollUser(baseUser);
    const row = await getUser(baseUser);
    const before = await mfaSnapshot(row.id);

    const response = await disableMfa(
      enrolled.accessToken,
      "not-the-right-password",
      freshCode(enrolled.secret, enrolled.enrolledAtStep),
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("auth_failed");

    // A failed proof must leave enrollment, codes, and audit untouched.
    expect(await mfaSnapshot(row.id)).toEqual(before);
  });

  it("rejects a wrong code with mfa_code_invalid and mutates nothing (mutation check: remove the code verification and this test goes red)", async () => {
    const enrolled = await enrollUser(baseUser);
    const row = await getUser(baseUser);
    const before = await mfaSnapshot(row.id);

    const response = await disableMfa(
      enrolled.accessToken,
      baseUser.password,
      "000000",
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("mfa_code_invalid");
    expect(await mfaSnapshot(row.id)).toEqual(before);
  });

  it("rejects a TOTP at or below the last used step even inside its window (mutation check: bypass last_totp_step and this test goes red)", async () => {
    const enrolled = await enrollUser(baseUser);
    const row = await getUser(baseUser);

    // Seed a future step so the presented code is genuinely valid for the
    // current window — only the replay guard can reject it.
    await prisma.user.update({
      where: { id: row.id },
      data: { last_totp_step: currentStep() + 5 },
    });

    const response = await disableMfa(
      enrolled.accessToken,
      baseUser.password,
      codeFor(enrolled.secret, currentStep()),
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("mfa_code_invalid");

    const after = await getUser(baseUser);
    expect(after.mfa_enrolled_at).not.toBeNull();
  });

  it("accepts an unused backup code as the second proof", async () => {
    const enrolled = await enrollUser(baseUser);

    const response = await disableMfa(
      enrolled.accessToken,
      baseUser.password,
      enrolled.backupCodes[0]!,
    );

    expect(response.status).toBe(200);

    const status = await api("GET", "/mfa", {
      accessToken: enrolled.accessToken,
    });
    expect(status.body).toEqual({ enrolled: false });
  });

  it("refuses a backup code already burned by a sign-in (mutation check: drop the used_at filter and this test goes red)", async () => {
    const enrolled = await enrollUser(baseUser);

    // Burn the code through the sign-in path it exists for; completing the
    // challenge replaces the enrollment's session, so continue with the
    // fresh access tokens it returned.
    const paused = await api("POST", "/login", {
      body: { email: baseUser.email, password: baseUser.password },
      projectId: project.id,
    });
    expect(paused.body.mfaRequired).toBe(true);

    const completed = await api("POST", "/mfa/challenge", {
      body: { challengeToken: paused.body.challengeToken, code: enrolled.backupCodes[0]! },
    });
    expect(completed.status).toBe(200);

    const response = await disableMfa(
      completed.body.accessToken,
      baseUser.password,
      enrolled.backupCodes[0]!,
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("mfa_code_invalid");

    const after = await getUser(baseUser);
    expect(after.mfa_enrolled_at).not.toBeNull();
  });

  it("refuses when there is nothing to disable", async () => {
    const accessToken = await registerUser(baseUser);

    const neverEnrolled = await disableMfa(
      accessToken,
      baseUser.password,
      "123456",
    );
    expect(neverEnrolled.status).toBe(409);
    expect(neverEnrolled.body.error.code).toBe("mfa_not_enrolled");

    const enrolled = await enrollUser(userFor("twice"));
    const first = await disableMfa(
      enrolled.accessToken,
      baseUser.password,
      freshCode(enrolled.secret, enrolled.enrolledAtStep),
    );
    expect(first.status).toBe(200);

    const second = await disableMfa(
      enrolled.accessToken,
      baseUser.password,
      freshCode(enrolled.secret, enrolled.enrolledAtStep),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("mfa_not_enrolled");
  });

  it("validates shape before touching anything", async () => {
    const enrolled = await enrollUser(baseUser);

    const missingPassword = await disableMfa(enrolled.accessToken, "", "123456");
    expect(missingPassword.status).toBe(400);
    expect(missingPassword.body.error.code).toBe("validation");

    const missingCode = await api("DELETE", "/mfa", {
      accessToken: enrolled.accessToken,
      body: { password: baseUser.password },
    });
    expect(missingCode.status).toBe(400);
    expect(missingCode.body.error.code).toBe("validation");
  });

  it("spends comparable time verifying a credential-less account as a real bad password (mutation check: skip verification when no stored hash exists and this test goes red)", async () => {
    const stripped = await enrollUser(userFor("stripped"));
    const intact = await enrollUser(userFor("intact"));

    // Remove the only credential account: the stored-hash lookup finds
    // nothing, so verification must fall back to the dummy hash instead of
    // skipping the comparison entirely.
    const strippedRow = await getUser(stripped.user);
    await prisma.account.deleteMany({
      where: { user_id: strippedRow.id, provider_id: CREDENTIAL_PROVIDER },
    });

    const rejected = await disableMfa(
      stripped.accessToken,
      baseUser.password,
      "000000",
    );
    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe("auth_failed");

    // The threshold is relative so the assertion holds at any machine speed;
    // both legs pay one Argon2id comparison per attempt.
    async function timedDisable(token: string, password: string) {
      const start = performance.now();
      await api("DELETE", "/mfa", {
        accessToken: token,
        body: { password, code: "000000" },
      });
      return performance.now() - start;
    }

    await timedDisable(stripped.accessToken, baseUser.password);
    await timedDisable(intact.accessToken, "wrong-password-here");

    const dummyHashPath: number[] = [];
    const realHashPath: number[] = [];
    for (let i = 0; i < 3; i++) {
      dummyHashPath.push(await timedDisable(stripped.accessToken, baseUser.password));
      realHashPath.push(await timedDisable(intact.accessToken, "wrong-password-here"));
    }

    const median = (samples: number[]) =>
      samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

    expect(median(dummyHashPath)).toBeGreaterThanOrEqual(
      0.5 * median(realHashPath),
    );
  }, 30_000);
});

describe("password reset clears enrollment", () => {
  const newPassword = "a-freshly-chosen-secret";

  async function requestResetToken(user: TestUser) {
    await api("POST", "/forgot-password", {
      body: { email: user.email },
      projectId: project.id,
    });

    const mail = mailer.lastTo(user.email);
    const match = mail?.text.match(/token=(\S+)/);

    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  }

  it("wipes enrollment and emits MFA_DISABLED reason password_reset while reset responses stay unchanged (mutation check: drop the wipe and these assertions go red)", async () => {
    const enrolled = await enrollUser(baseUser);
    const token = await requestResetToken(baseUser);
    expect(token).toBeString();

    const reset = await api("POST", "/reset-password", {
      body: { token, password: newPassword },
    });

    // Byte-identical outward contract to a reset for an unenrolled user.
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({
      message: "Password updated. Please sign in again.",
    });

    const after = await getUser(baseUser);
    expect(after.totp_secret).toBeNull();
    expect(after.mfa_enrolled_at).toBeNull();
    expect(after.last_totp_step).toBeNull();
    expect(after.mfa_grace_ends_at).toBeNull();
    expect(
      await prisma.mfaBackupCode.count({ where: { user_id: after.id } }),
    ).toBe(0);

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { user_id: after.id, event_type: "MFA_DISABLED" },
    });
    expect(event.severity).toBe("WARNING");
    expect(event.metadata).toEqual({ reason: "password_reset" });
    expect(event.project_id).toBe(project.id);

    // Sign-in returns to the single-phase contract on the new password.
    const login = await api("POST", "/login", {
      body: { email: baseUser.email, password: newPassword },
      projectId: project.id,
    });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBeUndefined();
    expect(login.body.accessToken).toBeString();

    expect(enrolled.accessToken).toBeString();
  });

  it("leaves the social-only reset path exactly as it was", async () => {
    await enrollUser(baseUser);
    const token = await requestResetToken(baseUser);
    expect(token).toBeString();

    // Unlink the credential between token issuance and completion — exactly
    // the state resetPassword's no-credential guard exists for.
    const row = await getUser(baseUser);
    await prisma.account.deleteMany({
      where: { user_id: row.id, provider_id: CREDENTIAL_PROVIDER },
    });

    const reset = await api("POST", "/reset-password", {
      body: { token, password: newPassword },
    });

    expect(reset.status).toBe(400);
    expect(reset.body.error.code).toBe("no_credential_account");

    // Nothing about the enrollment moved, and no MFA_DISABLED fired.
    const after = await getUser(baseUser);
    expect(after.mfa_enrolled_at).not.toBeNull();
    expect(after.totp_secret).not.toBeNull();
    expect(
      await prisma.securityEvent.count({
        where: { event_type: "MFA_DISABLED" },
      }),
    ).toBe(0);
    expect(await prisma.mfaBackupCode.count()).toBeGreaterThan(0);
  });
});
