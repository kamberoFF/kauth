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

  describe("listSessions", () => {
    it("returns a typed Page of the calling project's session summaries", async () => {
      const { sdk } = await bootstrap();

      const page = await sdk.listSessions();

      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
      const [session] = page.items;
      expect(session?.id).toBeDefined();
      expect(session?.userId).toBeDefined();
      expect(session?.status).toBe("ACTIVE");
    });

    it("filters by userId and round-trips multi-page results via nextCursor", async () => {
      const { sdk, owned } = await bootstrap();

      const user = await prisma.user.findFirstOrThrow({
        where: { project_id: owned.id },
      });
      // Three total sessions for the one user (bootstrap made one).
      for (let i = 0; i < 2; i += 1) {
        await prisma.session.create({
          data: {
            user_id: user.id,
            project_id: owned.id,
            expires_at: new Date(Date.now() + 86_400_000),
          },
        });
      }
      const stranger = await prisma.user.create({
        data: { project_id: owned.id, email: "stranger@example.com" },
      });
      await prisma.session.create({
        data: {
          user_id: stranger.id,
          project_id: owned.id,
          expires_at: new Date(Date.now() + 86_400_000),
        },
      });

      const first = await sdk.listSessions({ userId: user.id, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await sdk.listSessions({
        userId: user.id,
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(second.nextCursor).toBeNull();

      const ids = [...first.items, ...second.items].map((s) => s.id);
      expect(new Set(ids).size).toBe(3);
      const strangerSessions = await prisma.session.findMany({
        where: { user_id: stranger.id },
      });
      for (const s of strangerSessions) {
        expect(ids).not.toContain(s.id);
      }
    });
  });

  describe("listEvents", () => {
    it("returns a typed Page carrying the documented event fields", async () => {
      const { sdk } = await bootstrap();

      const page = await sdk.listEvents();

      expect(Array.isArray(page.items)).toBe(true);
      expect(page.items.length).toBeGreaterThan(0);
      const [event] = page.items;
      expect(event?.id).toBeDefined();
      expect(event?.eventType).toBeDefined();
      expect(event?.severity).toBeDefined();
      expect(event).toHaveProperty("metadata");
      expect(event?.createdAt).toBeDefined();
    });

    it("filters by eventType and by userId, and paginates", async () => {
      const { sdk, owned, publishable } = await bootstrap();

      // Generate a handful of LOGIN_FAILED events for the end user.
      for (let i = 0; i < 3; i += 1) {
        await api("POST", "/login", {
          body: { email: "enduser@example.com", password: "wrong-password" },
          apiKey: publishable,
        });
      }

      const failures = await sdk.listEvents({ eventType: "LOGIN_FAILED" });
      expect(failures.items.length).toBeGreaterThanOrEqual(3);
      for (const event of failures.items) {
        expect(event.eventType).toBe("LOGIN_FAILED");
      }

      const user = await prisma.user.findFirstOrThrow({
        where: { project_id: owned.id, email: "enduser@example.com" },
      });
      const forUser = await sdk.listEvents({ userId: user.id });
      for (const event of forUser.items) {
        expect(event.userId).toBe(user.id);
      }

      const firstPage = await sdk.listEvents({
        eventType: "LOGIN_FAILED",
        limit: 2,
      });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const nextPage = await sdk.listEvents({
        eventType: "LOGIN_FAILED",
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      const pagedIds = [...firstPage.items, ...nextPage.items].map((e) => e.id);
      expect(new Set(pagedIds).size).toBe(pagedIds.length);
    });

    it("accepts several event types as an array", async () => {
      const { sdk } = await bootstrap();

      const page = await sdk.listEvents({
        eventType: ["LOGIN_SUCCESS", "USER_REGISTERED"],
      });

      for (const event of page.items) {
        expect(["LOGIN_SUCCESS", "USER_REGISTERED"]).toContain(event.eventType);
      }
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

    it("fires from listSessions() and listEvents() before the body is read", async () => {
      await bootstrap();
      const stale = createKauthBackend({
        baseUrl,
        secretKey: "irrelevant-for-this-assertion",
        contractVersion: "0.0.0-stale",
      });

      for (const call of [
        () => stale.listSessions(),
        () => stale.listEvents(),
      ]) {
        let error: unknown;
        try {
          await call();
        } catch (caught) {
          error = caught;
        }
        expect((error as { code?: string }).code).toBe(
          "contract_version_mismatch",
        );
      }
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
