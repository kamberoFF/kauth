import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createOwnedProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { UUID_REGEX } from "../constants/regex";
import { createKauthClient } from "../../packages/client-sdk/src/index";
import { renderSessionHook } from "../../packages/client-sdk/dev/hookProbe";

const DEVICE_ID = "4f2b3c5d-6e7f-4a90-8b1c-3d4e5f6a7b80";

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

  return { owned, publishableKey, makeClient };
}

beforeAll(async () => {
  baseUrl = await startTestServer();
});
afterAll(stopTestServer);
beforeEach(resetDatabase);

describe("client SDK (real HTTP against the test server)", () => {
  describe("signUp", () => {
    it("creates an end-user session scoped to the key's project", async () => {
      const { owned, makeClient } = await bootstrap();
      const client = makeClient();

      const user = await client.signUp(END_USER);

      expect(user.email).toBe(END_USER.email);
      expect(client.getSnapshot()).toEqual({
        status: "signedIn",
        user,
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });

      const row = await prisma.user.findUniqueOrThrow({
        where: {
          project_id_email: { project_id: owned.id, email: END_USER.email },
        },
      });
      expect(row.username).toBe(END_USER.username);

      const session = await prisma.session.findFirstOrThrow({
        where: { project_id: owned.id },
      });
      expect(session.status).toBe("ACTIVE");
    });

    it("mints an access token the platform itself accepts", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();

      await client.signUp(END_USER);
      const { accessToken } = client.getSnapshot() as {
        status: "signedIn";
        accessToken: string;
      };

      const response = await api("GET", "/protected", { accessToken });
      expect(response.status).toBe(200);
    });

    it("surfaces the platform's duplicate_email code directly", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);

      let error: unknown;
      try {
        await client.signUp(END_USER);
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe("duplicate_email");
      expect((error as Error).name).toBe("KauthError");
    });
  });

  describe("device identity (server-issued, captured and echoed)", () => {
    it("signs up with no device header, captures the minted id, and echoes it on sign-out", async () => {
      const { owned, publishableKey } = await bootstrap();
      // No initial deviceId: the server must mint one.
      const client = createKauthClient({ baseUrl, publishableKey });

      await client.signUp(END_USER);
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

      const RETURNING_DEVICE = "5a3c4d6e-7f8a-4b01-9c2d-4e5f6a7b8c91";
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
        deviceId: "5a3c4d6e-7f8a-4b01-9c2d-4e5f6a7b8c91",
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

  describe("signOut", () => {
    it("revokes the session server-side and updates local state", async () => {
      const { owned, makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);

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
      await client.signOut();

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
      // store's post-transition snapshot, not a stale one.
      const before = probe(client);
      await client.signUp(END_USER);
      const after = probe(client);

      expect(before).toBe("out:-");
      expect(after).toBe(`in:${END_USER.email}`);
    });

    it("exposes no user profile when the session came from signIn", async () => {
      const { makeClient } = await bootstrap();
      const client = makeClient();
      await client.signUp(END_USER);

      const returning = makeClient({
        deviceId: "5a3c4d6e-7f8a-4b01-9c2d-4e5f6a7b8c91",
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
      expect(client.getSnapshot().status).toBe("signedIn");
    });

    // Not tested separately: a version-mismatched signOut. A stale client can
    // never hold local session state — its own signUp/signIn reject before any
    // state is set — so its signOut always no-ops before reaching the wire.
    // The logout path runs the same assertContractVersion as every other call.
  });
});
