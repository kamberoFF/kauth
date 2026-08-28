import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { decodeBase32 } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import {
  api,
  createOwnedProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { UUID_REGEX } from "../constants/regex";
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "../lib/totp";
import {
  createKauthClient,
  type KauthClient,
} from "../../packages/client-sdk/src/index";
import { renderSessionHook } from "../../packages/client-sdk/dev/hookProbe";

const DEVICE_ID = "4f2b3c5d-6e7f-4a90-8b1c-3d4e5f6a7b80";
const RETURNING_DEVICE_ID = "5a3c4d6e-7f8a-4b01-9c2d-4e5f6a7b8c91";

const END_USER = {
  email: "enduser@example.com",
  username: "enduser",
  password: "correct-horse-battery",
};

let baseUrl = "";

async function issuePublishableKey(accessToken: string, projectId: string) {
  const response = await api("POST", `/projects/${projectId}/keys`, {
    body: { type: "PUBLISHABLE" },
    accessToken,
  });

  return response.body.value as string;
}

/**
 * Full downstream-app simulation: an owned project and its publishable key.
 * Each call gets its own client so reactive-store assertions never observe
 * another client's transitions.
 */
async function bootstrap() {
  const { project: owned, developer } = await createOwnedProject();
  const publishableKey = await issuePublishableKey(
    developer.accessToken,
    owned.id,
  );

  const makeClient = (overrides?: {
    deviceId?: string;
    contractVersion?: string;
  }) =>
    createKauthClient({
      baseUrl,
      publishableKey,
      deviceId: overrides?.deviceId ?? DEVICE_ID,
      contractVersion: overrides?.contractVersion,
    });

  return {
    owned,
    publishableKey,
    makeClient,
    developerAccessToken: developer.accessToken,
  };
}

beforeAll(async () => {
  baseUrl = await startTestServer();
});
afterAll(stopTestServer);
beforeEach(resetDatabase);

describe("client SDK (real HTTP against the test server)", () => {
  describe("signUp", () => {
    it("registers the end user without signing them in (ADR 0008)", async () => {
      const { owned, makeClient } = await bootstrap();
      const client = makeClient();

      const result = await client.signUp(END_USER);

      expect(result).toBeUndefined();
      expect(client.getSnapshot().status).toBe("signedOut");

      const row = await prisma.user.findUniqueOrThrow({
        where: {
          project_id_email: { project_id: owned.id, email: END_USER.email },
        },
      });
      expect(row.username).toBe(END_USER.username);

      // No session on the register step.
      expect(
        await prisma.session.count({ where: { project_id: owned.id } }),
      ).toBe(0);
    });

    it("a following signIn reaches a session with a platform-accepted token", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();

      await client.signUp(END_USER);
      await client.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });

      expect(client.getSnapshot().status).toBe("signedIn");
      const { accessToken } = client.getSnapshot() as {
        status: "signedIn";
        accessToken: string;
      };

      const response = await api("GET", "/protected", { accessToken });
      expect(response.status).toBe(200);
    });

    it("resolves a duplicate-email signUp instead of throwing an oracle", async () => {
      const { owned, makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);

      // The server no longer returns duplicate_email (ADR 0008), so the SDK
      // cannot surface it: a second signUp on that address — under a fresh
      // username, so only the email collides — just resolves.
      await expect(
        client.signUp({ ...END_USER, username: "someone-else" }),
      ).resolves.toBeUndefined();
      expect(client.getSnapshot().status).toBe("signedOut");

      expect(
        await prisma.user.count({
          where: { project_id: owned.id, email: END_USER.email },
        }),
      ).toBe(1);
    });

    it("still throws duplicate_username", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);

      let error: unknown;
      try {
        await client.signUp({ ...END_USER, email: "someone-else@example.com" });
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe("duplicate_username");
      expect((error as Error).name).toBe("KauthError");
    });
  });

  describe("device identity (server-issued, captured and echoed)", () => {
    it("captures the server-issued device id at sign-in and echoes it on sign-out", async () => {
      const { owned, publishableKey } = await bootstrap();
      // No initial deviceId: the server must mint one.
      const client = createKauthClient({ baseUrl, publishableKey });

      await client.signUp(END_USER);
      await client.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });
      const session = await prisma.session.findFirstOrThrow({
        where: { project_id: owned.id },
      });
      expect(session.device_id).toMatch(UUID_REGEX);

      // Sign-out echoes the captured id, so logout passes requireDevice
      // without this client ever having generated an id itself.
      await client.signOut();
      expect(client.getSnapshot().status).toBe("signedOut");
    });

    it("replaces the previous session when a client re-uses one device id", async () => {
      const { owned, makeClient } = await bootstrap();
      const registered = makeClient();
      await registered.signUp(END_USER);
      await registered.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });

      const RETURNING_DEVICE = RETURNING_DEVICE_ID;
      const returning = makeClient({ deviceId: RETURNING_DEVICE });
      await returning.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });
      await returning.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });

      // The second sign-in replaces the first on the same device...
      const deviceSessions = await prisma.session.findMany({
        where: { project_id: owned.id, device_id: RETURNING_DEVICE },
        orderBy: { created_at: "asc" },
      });
      expect(deviceSessions).toHaveLength(2);
      expect(deviceSessions[0]!.status).toBe("REVOKED");
      expect(deviceSessions[0]!.revoked_reason).toBe(
        "replaced_by_new_login",
      );
      expect(deviceSessions[1]!.status).toBe("ACTIVE");

      // ...while the registration session on its own device survives.
      const registration = await prisma.session.findFirstOrThrow({
        where: {
          project_id: owned.id,
          device_id: { not: RETURNING_DEVICE },
        },
      });
      expect(registration.status).toBe("ACTIVE");
    });
  });

  describe("signIn", () => {
    it("signs an existing end user in with working tokens", async () => {
      const { makeClient } = await bootstrap();
      const registered = makeClient();
      await registered.signUp(END_USER);

      // A second device is how a returning user actually arrives: no signUp
      // in this client's history, only credentials and its own device id.
      const returning = makeClient({
        deviceId: RETURNING_DEVICE_ID,
      });
      await returning.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });

      const { accessToken } = returning.getSnapshot() as {
        status: "signedIn";
        accessToken: string;
      };
      expect(
        (await api("GET", "/protected", { accessToken })).status,
      ).toBe(200);
    });

    it("surfaces auth_failed on a bad password and stays signed out", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);

      const attacker = makeClient();

      let error: unknown;
      try {
        await attacker.signIn({
          email: END_USER.email,
          password: "wrong-password",
        });
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe("auth_failed");
      expect(attacker.getSnapshot().status).toBe("signedOut");
    });
  });

  describe("two-phase sign-in (MFA)", () => {
    function currentStep() {
      return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
    }

    function codeFor(secretBase32: string, step: number) {
      return generateHOTP(decodeBase32(secretBase32), BigInt(step), TOTP_DIGITS);
    }

    /** A code strictly newer than the one enrollment consumed, so completing
     * a challenge clears the replay guard no matter when this runs. */
    function freshCode(secret: string, enrolledAtStep: number) {
      return codeFor(secret, Math.max(currentStep(), enrolledAtStep + 1));
    }

    /** Signs the end user up through the SDK itself, then walks enrollment
     * with the session the SDK is holding — the way a real app would do it. */
    async function enrollUser(client: KauthClient) {
      const { accessToken } = client.getSnapshot() as {
        status: "signedIn";
        accessToken: string;
      };

      const started = await api("POST", "/mfa/enrollment", { accessToken });
      expect(started.status).toBe(200);

      const secret = started.body.secret as string;
      const enrolledAtStep = currentStep();
      const verified = await api("POST", "/mfa/enrollment/verify", {
        accessToken,
        body: { code: codeFor(secret, enrolledAtStep) },
      });
      expect(verified.status).toBe(200);

      return {
        secret,
        enrolledAtStep,
        backupCodes: verified.body.backupCodes as string[],
      };
    }

    /** One fresh project whose end user signed up and signed in through the
     * SDK, then finished TOTP enrollment with the session the SDK holds. */
    async function enrolledScenario() {
      const { owned, makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);
      await client.signIn({ email: END_USER.email, password: END_USER.password });
      const enrolled = await enrollUser(client);

      return { owned, makeClient, enrolled };
    }

    /** A returning device signing in up to the phase-one pause, with the
     * discriminated result narrowed so tests read `challengeToken`. */
    async function pausedSignIn(
      makeClient: (overrides?: { deviceId?: string }) => KauthClient,
    ) {
      const returning = makeClient({
        deviceId: RETURNING_DEVICE_ID,
      });
      const result = await returning.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });

      if (!result.mfaRequired) {
        throw new Error("expected an MFA challenge, got a session");
      }

      return { returning, challengeToken: result.challengeToken };
    }

    function expectKauthCode(error: unknown, code: string) {
      expect((error as { code?: string }).code).toBe(code);
      expect((error as Error).name).toBe("KauthError");
    }

    it("pauses an enrolled user's signIn at the challenge, signed-out and sessionless", async () => {
      const { owned, makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);
      await client.signIn({ email: END_USER.email, password: END_USER.password });
      await enrollUser(client);

      const returning = makeClient({
        deviceId: RETURNING_DEVICE_ID,
      });
      const result = await returning.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });

      expect(result).toEqual({
        mfaRequired: true,
        challengeToken: expect.any(String),
        expiresInSeconds: 300,
      });

      // Phase one must not look signed-in locally...
      expect(returning.getSnapshot().status).toBe("signedOut");

      // ...nor create anything server-side on the new device: only the
      // registration's own session exists.
      const sessions = await prisma.session.findMany({
        where: { project_id: owned.id },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.device_id).toBe(DEVICE_ID);
    });

    it("finishSignIn turns the challenge into working tokens", async () => {
      const { owned, makeClient, enrolled } = await enrolledScenario();

      const { returning, challengeToken } = await pausedSignIn(makeClient);
      await returning.finishSignIn(
        challengeToken,
        freshCode(enrolled.secret, enrolled.enrolledAtStep),
      );

      const snapshot = returning.getSnapshot();
      expect(snapshot.status).toBe("signedIn");

      // The completed login is a real session, not a local fiction.
      const { accessToken } = snapshot as {
        status: "signedIn";
        accessToken: string;
      };
      expect((await api("GET", "/protected", { accessToken })).status).toBe(200);

      const session = await prisma.session.findFirstOrThrow({
        where: {
          project_id: owned.id,
          device_id: RETURNING_DEVICE_ID,
        },
      });
      expect(session.status).toBe("ACTIVE");
    });

    it("a wrong code surfaces mfa_code_invalid and leaves the sign-in recoverable", async () => {
      const { makeClient, enrolled } = await enrolledScenario();

      const { returning, challengeToken } = await pausedSignIn(makeClient);

      let error: unknown;
      try {
        await returning.finishSignIn(challengeToken, "000000");
      } catch (caught) {
        error = caught;
      }

      expectKauthCode(error, "mfa_code_invalid");
      expect(returning.getSnapshot().status).toBe("signedOut");

      // A wrong code never burns the token: the right one still completes.
      await returning.finishSignIn(
        challengeToken,
        freshCode(enrolled.secret, enrolled.enrolledAtStep),
      );
      expect(returning.getSnapshot().status).toBe("signedIn");
    });

    it("accepts a single-use backup code as the second factor", async () => {
      const { makeClient, enrolled } = await enrolledScenario();

      const { returning, challengeToken } = await pausedSignIn(makeClient);
      await returning.finishSignIn(challengeToken, enrolled.backupCodes[0]!);

      expect(returning.getSnapshot().status).toBe("signedIn");
    });

    it("answers an unknown challenge token with token_invalid and stays signed out", async () => {
      const { makeClient } = await enrolledScenario();

      const { returning } = await pausedSignIn(makeClient);

      let error: unknown;
      try {
        await returning.finishSignIn("not-a-real-challenge-token", "123456");
      } catch (caught) {
        error = caught;
      }

      expectKauthCode(error, "token_invalid");
      expect(returning.getSnapshot().status).toBe("signedOut");
    });

    it("surfaces the mandate's grace deadline to an unenrolled user's signIn", async () => {
      const { owned, developerAccessToken, makeClient } = await bootstrap();

      const patched = await api("PATCH", `/projects/${owned.id}`, {
        accessToken: developerAccessToken,
        body: { enforce_mfa: true },
      });
      expect(patched.status).toBe(200);

      const client = makeClient();
      await client.signUp(END_USER);

      const returning = makeClient({
        deviceId: RETURNING_DEVICE_ID,
      });
      const result = await returning.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });

      // No enrollment, so no pause — but the mandate's window is visible.
      if (result.mfaRequired) {
        throw new Error("expected a straight sign-in, got an MFA challenge");
      }

      expect(result).toEqual({
        mfaRequired: false,
        mfaGraceEndsAt: expect.any(String),
      });
      expect(new Date(result.mfaGraceEndsAt!).getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect(returning.getSnapshot().status).toBe("signedIn");
    });
  });

  describe("signOut", () => {
    it("revokes the session server-side and updates local state", async () => {
      const { owned, makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);
      await client.signIn({ email: END_USER.email, password: END_USER.password });

      const { accessToken } = client.getSnapshot() as {
        status: "signedIn";
        accessToken: string;
      };
      await client.signOut();

      expect(client.getSnapshot().status).toBe("signedOut");

      // Logout is not cosmetic: the still-unexpired token dies server-side.
      expect((await api("GET", "/protected", { accessToken })).status).toBe(401);

      const session = await prisma.session.findFirstOrThrow({
        where: { project_id: owned.id },
      });
      expect(session.status).toBe("REVOKED");
    });

    it("is a no-op when already signed out", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();

      await expect(client.signOut()).resolves.toBeUndefined();
      expect(client.getSnapshot().status).toBe("signedOut");
    });
  });

  describe("reactive session state", () => {
    it("notifies subscribers on each signedIn/signedOut transition", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();
      const seen: string[] = [];
      const unsubscribe = client.subscribe(() => {
        seen.push(client.getSnapshot().status);
      });

      await client.signUp(END_USER);
      await client.signIn({ email: END_USER.email, password: END_USER.password });
      await client.signOut();

      // signUp does not transition (ADR 0008); only signIn and signOut do.
      expect(seen).toEqual(["signedIn", "signedOut"]);
      unsubscribe();
    });

    it("stops notifying after unsubscribe", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();
      let calls = 0;
      const unsubscribe = client.subscribe(() => {
        calls += 1;
      });
      unsubscribe();

      await client.signUp(END_USER);
      await client.signIn({ email: END_USER.email, password: END_USER.password });

      expect(calls).toBe(0);
    });
  });

  describe("useSession hook", () => {
    /**
     * `renderSessionHook` runs the real hook through React's own runtime —
     * `useSyncExternalStore` executes, not just imports. The probe serialises
     * the hook result into markup: "in|out" plus the profile the hook
     * exposes, if any.
     */
    const probe = renderSessionHook;

    it("reports signed-out state before anything happens", async () => {
      const { makeClient } = await bootstrap();

      expect(probe(makeClient())).toBe("out:-");
    });

    it("reflects a session created after mount-time state changed", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();

      // Same client instance across renders — the second render must read the
      // store's post-transition snapshot, not a stale one. signUp does not
      // transition (ADR 0008); signIn does, with a null user until a /me.
      const before = probe(client);
      await client.signUp(END_USER);
      const afterSignUp = probe(client);
      await client.signIn({ email: END_USER.email, password: END_USER.password });
      const afterSignIn = probe(client);

      expect(before).toBe("out:-");
      expect(afterSignUp).toBe("out:-");
      expect(afterSignIn).toBe("in:-");
    });

    it("exposes no user profile when the session came from signIn", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);

      const returning = makeClient({
        deviceId: RETURNING_DEVICE_ID,
      });
      await returning.signIn({
        email: END_USER.email,
        password: END_USER.password,
      });

      expect(probe(returning)).toBe("in:-");
    });
  });

  describe("contract version enforcement (ADR 0003)", () => {
    it("hard-fails on a mismatch, with a may-have-completed message", async () => {
      const { owned, makeClient } = await bootstrap();
      const stale = makeClient({ contractVersion: "0.0.0-stale" });

      let error: unknown;
      try {
        await stale.signUp(END_USER);
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe(
        "contract_version_mismatch",
      );
      const message = (error as Error).message;
      expect(message).toContain("may have already completed");
      expect(message.toLowerCase()).toContain("retried");

      // A mutating call completes before the response header can be checked.
      const row = await prisma.user.findUnique({
        where: {
          project_id_email: { project_id: owned.id, email: END_USER.email },
        },
      });
      expect(row).not.toBeNull();
    });

    it("the healthy client keeps working after observing a stale one fail", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();
      const stale = makeClient({ contractVersion: "0.0.0-stale" });

      await stale
        .signIn({ email: END_USER.email, password: END_USER.password })
        .catch(() => undefined);

      await client.signUp(END_USER);
      await client.signIn({ email: END_USER.email, password: END_USER.password });
      expect(client.getSnapshot().status).toBe("signedIn");
    });

    // Not tested separately: a version-mismatched signOut. A stale client can
    // never hold local session state — its own signUp/signIn reject before any
    // state is set — so its signOut always no-ops before reaching the wire.
    // The logout path runs the same assertContractVersion as every other call.
  });
});
