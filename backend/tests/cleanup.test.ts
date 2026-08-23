import { beforeEach, describe, expect, it } from "bun:test";
import { createTestProject, resetDatabase } from "./helpers/api";
import { prisma } from "../lib/prisma";
import { runCleanup } from "../scripts/cleanup";

let project: Awaited<ReturnType<typeof createTestProject>>;
let userCounter = 0;

beforeEach(resetDatabase);
beforeEach(async () => {
  project = await createTestProject();
  userCounter = 0;
});

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function seedUser() {
  userCounter += 1;
  return prisma.user.create({
    data: { project_id: project.id, email: `cleanup-user-${userCounter}@example.com` },
  });
}

function seedSession(
  userId: string,
  overrides: {
    status?: "ACTIVE" | "REVOKED" | "EXPIRED";
    expires_at?: Date;
    revoked_at?: Date | null;
  } = {},
) {
  return prisma.session.create({
    data: {
      user_id: userId,
      project_id: project.id,
      status: overrides.status ?? "ACTIVE",
      expires_at: overrides.expires_at ?? daysAgo(-30),
      revoked_at: overrides.revoked_at ?? null,
    },
  });
}

function seedRefreshToken(
  sessionId: string,
  userId: string,
  overrides: {
    status?: "ACTIVE" | "CONSUMED" | "REVOKED" | "EXPIRED";
    expires_at?: Date;
    consumed_at?: Date | null;
  } = {},
) {
  const unique = crypto.randomUUID();

  return prisma.refreshToken.create({
    data: {
      session_id: sessionId,
      user_id: userId,
      project_id: project.id,
      family_id: crypto.randomUUID(),
      selector: `selector-${unique}`,
      token_hash: `hash-${unique}`,
      status: overrides.status ?? "ACTIVE",
      expires_at: overrides.expires_at ?? daysAgo(-30),
      consumed_at: overrides.consumed_at ?? null,
    },
  });
}

function seedSecurityEvent(sessionId: string, userId: string, createdAt: Date) {
  return prisma.securityEvent.create({
    data: {
      event_type: "LOGIN_SUCCESS",
      severity: "INFO",
      session_id: sessionId,
      user_id: userId,
      project_id: project.id,
      created_at: createdAt,
    },
  });
}

describe("cleanup job", () => {
  it("is a safe no-op when nothing is eligible", async () => {
    const user = await seedUser();
    await seedSession(user.id);

    // Deliberately not `await expect(...).resolves` — under bun test this
    // suite reliably deadlocked inside that matcher (bun 1.3.14), while an
    // explicit await behaves. Same assertion, no matcher indirection.
    const result = await runCleanup();
    expect(result).toEqual({
      refreshTokensDeleted: 0,
      securityEventsDeleted: 0,
      sessionsDeleted: 0,
    });
  });

  describe("refresh tokens", () => {
    it("deletes consumed tokens past their own retention window", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id);
      const stale = await seedRefreshToken(session.id, user.id, {
        status: "CONSUMED",
        consumed_at: daysAgo(45),
      });
      const fresh = await seedRefreshToken(session.id, user.id, {
        status: "CONSUMED",
        consumed_at: daysAgo(5),
      });

      await runCleanup();

      expect(await prisma.refreshToken.findUnique({ where: { id: stale.id } })).toBeNull();
      expect(await prisma.refreshToken.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    });

    it("deletes clock-expired tokens even when status was never updated", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id);
      const expired = await seedRefreshToken(session.id, user.id, {
        status: "ACTIVE",
        expires_at: daysAgo(45),
      });

      await runCleanup();

      expect(await prisma.refreshToken.findUnique({ where: { id: expired.id } })).toBeNull();
    });

    it("respects CLEANUP_RETENTION_DAYS independently of AUDIT_RETENTION_DAYS", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id);
      // Older than the 30-day refresh-token default, nowhere near the
      // 365-day audit default.
      const stale = await seedRefreshToken(session.id, user.id, {
        status: "CONSUMED",
        consumed_at: daysAgo(60),
      });

      await runCleanup();

      expect(await prisma.refreshToken.findUnique({ where: { id: stale.id } })).toBeNull();
    });

    it("leaves revoked tokens for the session's own coordinated deletion", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id);
      const revoked = await seedRefreshToken(session.id, user.id, {
        status: "REVOKED",
        expires_at: daysAgo(45),
      });

      await runCleanup();

      expect(await prisma.refreshToken.findUnique({ where: { id: revoked.id } })).not.toBeNull();
    });
  });

  describe("audit events", () => {
    it("deletes events past their own retention window", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id);
      const stale = await seedSecurityEvent(session.id, user.id, daysAgo(400));
      const fresh = await seedSecurityEvent(session.id, user.id, daysAgo(10));

      await runCleanup();

      expect(await prisma.securityEvent.findUnique({ where: { id: stale.id } })).toBeNull();
      expect(await prisma.securityEvent.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    });
  });

  describe("the mutation-critical session/audit ordering guarantee", () => {
    it("never deletes a session while a within-retention event still references it", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id, {
        status: "REVOKED",
        revoked_at: daysAgo(400), // long past its own retention window
      });
      await seedSecurityEvent(session.id, user.id, daysAgo(10)); // still fresh

      await runCleanup();

      expect(await prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    });

    it("deletes the session once its last referencing event ages out too", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id, {
        status: "REVOKED",
        revoked_at: daysAgo(400),
      });
      await seedSecurityEvent(session.id, user.id, daysAgo(400)); // itself past retention

      await runCleanup();

      expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    });

    it("never deletes a recently-revoked session even with no referencing event at all", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id, {
        status: "REVOKED",
        revoked_at: daysAgo(5),
      });

      await runCleanup();

      expect(await prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    });

    it("never leaves an audit event pointing at a session that no longer exists", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id, {
        status: "REVOKED",
        revoked_at: daysAgo(400),
      });
      // Old enough itself to be cleared in step 2, so nothing should remain
      // referencing `session` afterwards.
      await seedSecurityEvent(session.id, user.id, daysAgo(400));

      await runCleanup();

      const remaining = await prisma.securityEvent.findMany({
        where: { session_id: session.id },
      });
      expect(remaining).toEqual([]);
    });

    it("leaves an untouched, still-active session alone regardless of audit events", async () => {
      const user = await seedUser();
      const session = await seedSession(user.id, {
        status: "ACTIVE",
        expires_at: daysAgo(-30),
      });
      await seedSecurityEvent(session.id, user.id, daysAgo(400));

      await runCleanup();

      expect(await prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    });
  });
});
