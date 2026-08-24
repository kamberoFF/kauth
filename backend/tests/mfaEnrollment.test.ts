import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { decodeBase32, encodeBase32NoPadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { decrypt } from "../lib/cryptoBox";
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "../lib/totp";

const credentials = {
  email: "mfa-enroll@example.com",
  username: "mfa-enroll",
  password: "correct-horse-battery",
};

let project: Awaited<ReturnType<typeof createTestProject>>;

function currentStep() {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
}

function codeFor(secretBase32: string, step: number) {
  return generateHOTP(decodeBase32(secretBase32), BigInt(step), TOTP_DIGITS);
}

/** Independent of lib/backupCodes on purpose: the stored digest must equal a
 * plain sha256 of the canonical (dashless, uppercase) form — recomputing the
 * expectation here keeps the assertion from circularly trusting the lib. */
function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalCode(code: string) {
  return code.replaceAll("-", "").toUpperCase();
}

async function registerUser() {
  const registered = await api("POST", "/register", {
    body: credentials,
    projectId: project.id,
  });

  return registered.body.accessToken as string;
}

async function startEnrollment(accessToken: string) {
  return api("POST", "/mfa/enrollment", { accessToken });
}

async function verifyEnrollment(accessToken: string, code: string) {
  return api("POST", "/mfa/enrollment/verify", {
    accessToken,
    body: { code },
  });
}

async function getUser() {
  // Registration is the only identity source this suite needs; the project
  // scoping makes the email unique again after each resetDatabase().
  return prisma.user.findUniqueOrThrow({
    where: {
      project_id_email: { project_id: project.id, email: credentials.email },
    },
  });
}

beforeAll(startTestServer);

afterAll(stopTestServer);

beforeEach(async () => {
  await resetDatabase();
  project = await createTestProject();
});

describe("POST /mfa/enrollment", () => {
  it("requires authentication", async () => {
    const response = await startEnrollment("");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_missing");
  });

  it("returns an otpauth uri and plaintext secret once, storing only ciphertext", async () => {
    const accessToken = await registerUser();

    const response = await startEnrollment(accessToken);

    expect(response.status).toBe(200);
    expect(response.body.secret).toMatch(/^[A-Z2-7]{32}$/);

    // WHATWG URL parsing puts "totp" in host for non-special schemes.
    const uri = new URL(response.body.otpauthUri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/kauth:mfa-enroll");
    expect(uri.searchParams.get("secret")).toBe(response.body.secret);
    expect(uri.searchParams.get("issuer")).toBe("kauth");
    expect(uri.searchParams.get("algorithm")).toBe("SHA1");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");

    const user = await getUser();
    // The column never holds what was shown to the client, but must decrypt
    // back to it — enrollment has to be recoverable to verify later codes.
    expect(user.totp_secret).not.toBe(response.body.secret);
    expect(decrypt(user.totp_secret!)).toBe(response.body.secret);
    expect(user.mfa_enrolled_at).toBeNull();

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "MFA_ENROLLMENT_STARTED" },
    });
    expect(event.severity).toBe("INFO");
    expect(event.user_id).toBe(user.id);
  });

  it("replaces a pending secret and invalidates codes from the old one (mutation check: make restart keep the old secret and this test goes red)", async () => {
    const accessToken = await registerUser();

    const first = await startEnrollment(accessToken);
    const second = await startEnrollment(accessToken);

    expect(second.status).toBe(200);
    expect(second.body.secret).not.toBe(first.body.secret);

    const staleStep = currentStep();
    const staleAttempt = await verifyEnrollment(
      accessToken,
      codeFor(first.body.secret, staleStep),
    );
    expect(staleAttempt.status).toBe(401);
    expect(staleAttempt.body.error.code).toBe("mfa_code_invalid");

    const fresh = await verifyEnrollment(
      accessToken,
      codeFor(second.body.secret, currentStep()),
    );
    expect(fresh.status).toBe(200);
  });

  it("refuses enrollment while already enrolled (mutation check: delete this guard and this test goes red)", async () => {
    const accessToken = await registerUser();
    const started = await startEnrollment(accessToken);
    const verified = await verifyEnrollment(
      accessToken,
      codeFor(started.body.secret, currentStep()),
    );
    expect(verified.status).toBe(200);

    const userBefore = await getUser();

    const again = await startEnrollment(accessToken);

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("mfa_already_enrolled");

    const userAfter = await getUser();
    expect(userAfter.totp_secret).toBe(userBefore.totp_secret);
  });
});

describe("POST /mfa/enrollment/verify", () => {
  it("rejects a wrong code, stays pending, and still allows a correct retry", async () => {
    const accessToken = await registerUser();
    const started = await startEnrollment(accessToken);

    // A code minted from a foreign (well-formed) secret cannot match ±1 step
    // except by astronomical luck, so this exercises the rejection path
    // deterministically.
    const foreign = encodeBase32NoPadding(crypto.randomBytes(20));
    const wrong = await verifyEnrollment(accessToken, codeFor(foreign, currentStep()));

    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("mfa_code_invalid");

    // Deliberately no security event for a failed check: the limiter is the
    // control here. Only the STARTED trace may exist at this point.
    const enrolledEvent = await prisma.securityEvent.findFirst({
      where: { event_type: "MFA_ENROLLED" },
    });
    expect(enrolledEvent).toBeNull();
    const userMidway = await getUser();
    expect(userMidway.mfa_enrolled_at).toBeNull();
    expect(userMidway.last_totp_step).toBeNull();
    expect(await prisma.mfaBackupCode.count()).toBe(0);

    const retry = await verifyEnrollment(
      accessToken,
      codeFor(started.body.secret, currentStep()),
    );
    expect(retry.status).toBe(200);
  });

  it("enrolls on a correct code: one-time backup codes, replay seed, audit trail", async () => {
    const accessToken = await registerUser();
    const started = await startEnrollment(accessToken);
    const stepLowerBound = currentStep() - 1;

    const verified = await verifyEnrollment(
      accessToken,
      codeFor(started.body.secret, currentStep()),
    );

    expect(verified.status).toBe(200);

    const backupCodes: unknown[] = verified.body.backupCodes;
    expect(backupCodes).toBeArrayOfSize(10);
    for (const code of backupCodes) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
    expect(new Set(backupCodes).size).toBe(10);

    const rows = await prisma.mfaBackupCode.findMany();
    expect(rows).toBeArrayOfSize(10);
    const storedHashes = new Set(rows.map((row) => row.code_hash));
    // Mutation check: store the plaintext code as code_hash instead of its
    // sha256 and every assertion from here to the end of the loop goes red.
    for (const raw of backupCodes as string[]) {
      const canonical = canonicalCode(raw);
      // Hashed only: neither the displayed nor the canonical form may appear
      // in storage, and each digest matches exactly the expected sha256.
      expect(storedHashes.has(raw)).toBe(false);
      expect(storedHashes.has(canonical)).toBe(false);
      expect(storedHashes.has(sha256Hex(canonical))).toBe(true);
      expect(rows.find((row) => row.code_hash === sha256Hex(canonical))?.used_at).toBeNull();
    }
    for (const row of rows) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    const stepUpperBound = currentStep();
    const user = await getUser();
    expect(user.mfa_enrolled_at).not.toBeNull();
    expect(user.mfa_grace_ends_at).toBeNull();
    // Replay defense seed: the matched step is persisted within the window
    // that was live during verification.
    expect(user.last_totp_step).toBeGreaterThanOrEqual(stepLowerBound);
    expect(user.last_totp_step!).toBeLessThanOrEqual(stepUpperBound);

    const enrolled = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "MFA_ENROLLED" },
    });
    expect(enrolled.severity).toBe("WARNING");
    expect(enrolled.user_id).toBe(user.id);

    const status = await api("GET", "/mfa", { accessToken });
    expect(status.status).toBe(200);
    expect(status.body.enrolled).toBe(true);
    expect(status.body.backupCodesRemaining).toBe(10);
    expect("graceEndsAt" in status.body).toBe(false);
  });

  it("refuses verification with no pending enrollment", async () => {
    const accessToken = await registerUser();

    const response = await verifyEnrollment(accessToken, "123456");

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("mfa_not_pending");
  });

  it("refuses re-verification once enrolled", async () => {
    const accessToken = await registerUser();
    const started = await startEnrollment(accessToken);
    await verifyEnrollment(accessToken, codeFor(started.body.secret, currentStep()));

    const response = await api("POST", "/mfa/enrollment/verify", {
      accessToken,
      body: { code: "654321" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("mfa_already_enrolled");
  });

  it("rejects a malformed body", async () => {
    const accessToken = await registerUser();
    await startEnrollment(accessToken);

    const missing = await verifyEnrollment(accessToken, "");
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("validation");

    const notAString = await api("POST", "/mfa/enrollment/verify", {
      accessToken,
      body: { code: 123456 },
    });
    expect(notAString.status).toBe(400);
    expect(notAString.body.error.code).toBe("validation");
  });
});

describe("GET /mfa", () => {
  it("reports an unenrolled user with no extra keys", async () => {
    const accessToken = await registerUser();

    const response = await api("GET", "/mfa", { accessToken });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enrolled: false });
  });

  it("reports pending enrollment as not yet enrolled", async () => {
    const accessToken = await registerUser();
    await startEnrollment(accessToken);

    const response = await api("GET", "/mfa", { accessToken });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enrolled: false });
  });

  it("counts only unused backup codes after enrollment", async () => {
    const accessToken = await registerUser();
    const started = await startEnrollment(accessToken);
    const verified = await verifyEnrollment(
      accessToken,
      codeFor(started.body.secret, currentStep()),
    );
    const [first] = verified.body.backupCodes as string[];
    expect(first).toBeDefined();

    await prisma.mfaBackupCode.updateMany({
      data: { used_at: new Date() },
      where: { code_hash: sha256Hex(canonicalCode(first!)) },
    });

    const response = await api("GET", "/mfa", { accessToken });

    expect(response.status).toBe(200);
    expect(response.body.enrolled).toBe(true);
    expect(response.body.backupCodesRemaining).toBe(9);
  });
});
