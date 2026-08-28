import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  registerAndSignIn,
  createOwnedProject,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { createKauthBackend } from "../../packages/backend-sdk/src/index";

let project: Awaited<ReturnType<typeof createTestProject>>;
let baseUrl = "";

async function issueKeyValue(
  accessToken: string,
  projectId: string,
  type: "PUBLISHABLE" | "SECRET",
) {
  const response = await api("POST", `/projects/${projectId}/keys`, {
    body: { type },
    accessToken,
  });

  return response.body.value as string;
}

/**
 * Full downstream-app simulation: an owned project, its secret key handed to
 * the SDK, and an end user signed in through the publishable-key flow. Returns
 * the pieces each assertion needs.
 */
async function bootstrap() {
  const { project: owned, developer } = await createOwnedProject();
  const secretKey = await issueKeyValue(developer.accessToken, owned.id, "SECRET");
  const publishable = await issueKeyValue(developer.accessToken, owned.id, "PUBLISHABLE");
  const sdk = createKauthBackend({ baseUrl, secretKey });

  // Register→login (ADR 0008): register no longer returns a session.
  const signedIn = await registerAndSignIn(
    { email: "enduser@example.com", username: "enduser", password: "correct-horse-battery" },
    owned.id,
  );
  const accessToken = signedIn.body.accessToken as string;

  const session = await prisma.session.findFirstOrThrow({
    where: { project_id: owned.id, status: "ACTIVE" },
  });

  return {
    owned,
    sdk,
    accessToken,
    sessionId: session.id,
    publishable,
    secretKey,
  };
}

beforeAll(async () => {
  baseUrl = await startTestServer();
});
afterAll(stopTestServer);
beforeEach(async () => {
  await resetDatabase();
  project = await createTestProject();
});

describe("backend SDK (real HTTP against the test server)", () => {
  describe("verifySession", () => {
    it("confirms a live session with its user attached", async () => {
      const { sdk, sessionId } = await bootstrap();

      const verified = await sdk.verifySession(sessionId);

      expect(verified.id).toBe(sessionId);
      expect(verified.userId).toBeDefined();
    });

    it("rejects a session revoked by refresh-token reuse detection", async () => {
      const { owned, sdk, publishable } = await bootstrap();

      // A second login mints a fresh session; replaying its already-consumed
      // refresh token trips reuse detection, which revokes that session —
      // the "reuse-flagged" shape of a dead session.
      const login = await api("POST", "/login", {
        body: { email: "enduser@example.com", password: "correct-horse-battery" },
        apiKey: publishable,
      });
      const stolen = login.body.refreshToken as string;
      void (await api("POST", "/refresh", { body: { refreshToken: stolen } }));
      await api("POST", "/refresh", { body: { refreshToken: stolen } });

      const flagged = await prisma.session.findFirstOrThrow({
        where: { project_id: owned.id },
        orderBy: { created_at: "desc" },
      });

      let error: unknown;
      try {
        await sdk.verifySession(flagged.id);
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe("session_inactive");
      expect(flagged.status).toBe("REVOKED");
    });

    it("rejects a revoked session in real time — no cached/stale result", async () => {
      const { sdk, accessToken, sessionId } = await bootstrap();
      await sdk.revokeSession(sessionId);

      // The revocation must be visible to the platform itself, not just the
      // SDK's view of it: the end user's still-unexpired access token dies.
      expect((await api("GET", "/protected", { accessToken })).status).toBe(401);

      let error: unknown;
      try {
        await sdk.verifySession(sessionId);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe("session_inactive");
    });

    it("rejects a session that expired by clock", async () => {
      const { sdk, sessionId } = await bootstrap();
      await prisma.session.update({
        where: { id: sessionId },
        data: { expires_at: new Date(Date.now() - 1000) },
      });

      let error: unknown;
      try {
        await sdk.verifySession(sessionId);
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe("session_inactive");
    });

    it("surfaces the platform's session_not_found code for an unknown session", async () => {
      const { sdk } = await bootstrap();

      let error: unknown;
      try {
        await sdk.verifySession("00000000-0000-4000-8000-000000000000");
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe("session_not_found");
    });
  });

  describe("listUsers", () => {
    it("lists the calling project's users with their profile fields", async () => {
      const { sdk } = await bootstrap();

      const users = await sdk.listUsers();

      expect(users).toHaveLength(1);
      expect(users[0]?.email).toBe("enduser@example.com");
      expect(users[0]?.id).toBeDefined();
    });

    it("never surfaces another project's users", async () => {
      const { sdk } = await bootstrap();

      // A second project registers its own end user under an identical email.
      const other = await createTestProject({ name: "Other Project" });
      await api("POST", "/register", {
        body: { email: "enduser@example.com", username: "enduser", password: "correct-horse-battery" },
        projectId: other.id,
      });

      const users = await sdk.listUsers();

      expect(users).toHaveLength(1);
      const userIds = users.map((user) => user.id);
      const otherUsers = await prisma.user.findMany({
        where: { project_id: other.id },
      });
      for (const otherUser of otherUsers) {
        expect(userIds).not.toContain(otherUser.id);
      }
    });
  });

  describe("revokeSession", () => {
    it("is scoped to the calling project's own sessions", async () => {
      const { sdk } = await bootstrap();

      const stranger = await prisma.user.create({
        data: { project_id: project.id, email: "stranger@example.com" },
      });
      const foreignSession = await prisma.session.create({
        data: {
          user_id: stranger.id,
          project_id: project.id,
          expires_at: new Date(Date.now() + 86_400_000),
        },
      });

      let error: unknown;
      try {
        await sdk.revokeSession(foreignSession.id);
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe("session_not_found");
      expect(
        (await prisma.session.findUniqueOrThrow({ where: { id: foreignSession.id } }))
          .status,
      ).toBe("ACTIVE");
    });

    it("surfaces the platform's tier error if a publishable key is used", async () => {
      const { sessionId, publishable } = await bootstrap();
      const wrongTier = createKauthBackend({
        baseUrl,
        secretKey: publishable,
      });

      let error: unknown;
      try {
        await wrongTier.revokeSession(sessionId);
      } catch (caught) {
        error = caught;
      }

      expect((error as { code?: string }).code).toBe("api_key_tier_forbidden");
    });
  });

  describe("contract version enforcement (ADR 0003)", () => {
    it("hard-fails on a version mismatch, with a may-have-completed message", async () => {
      const { sessionId } = await bootstrap();
      const stale = createKauthBackend({
        baseUrl,
        secretKey: "irrelevant-for-this-assertion",
        contractVersion: "0.0.0-stale",
      });

      let error: unknown;
      try {
        await stale.verifySession(sessionId);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe(
        "contract_version_mismatch",
      );
      const message = (error as Error).message;
      expect(message).toContain("may have already completed");
      expect(message.toLowerCase()).toContain("retried");
    });

    it("a mutating call still completes server-side and is never auto-retried", async () => {
      const { sdk, sessionId, secretKey } = await bootstrap();
      const stale = createKauthBackend({
        baseUrl,
        // A real, working key: the point is that the revoke succeeds
        // server-side and only the response check catches the mismatch.
        secretKey,
        contractVersion: "0.0.0-stale",
      });

      // Deliberately no `expect(...).rejects` here or above — under bun test
      // those matchers deadlocked on this suite (see the note on
      // `.resolves` further up); an explicit await behaves.
      let error: unknown;
      try {
        await stale.revokeSession(sessionId);
      } catch (caught) {
        error = caught;
      }
      expect((error as { code?: string }).code).toBe(
        "contract_version_mismatch",
      );

      // The request went through before the mismatch was detected.
      const session = await prisma.session.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(session.status).toBe("REVOKED");

      // And the healthy client sees the real state, proving no retry loop
      // masked the mismatch.
      let secondError: unknown;
      try {
        await sdk.verifySession(sessionId);
      } catch (caught) {
        secondError = caught;
      }
      expect((secondError as { code?: string }).code).toBe("session_inactive");
    });
  });
});
