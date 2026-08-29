import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createOwnedProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { ensurePlatformProject } from "../lib/platformProject";
import type { Prisma } from "../generated/prisma/client";
import type { SecurityEventType } from "../generated/prisma/enums";

const EVENT_KEYS = [
  "id",
  "eventType",
  "severity",
  "userId",
  "sessionId",
  "ip",
  "userAgent",
  "metadata",
  "createdAt",
].sort();

async function issueKey(
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
 * Direct inserts so a test controls the count, the types, the owners, and the
 * ordering key precisely. The HTTP flows that actually write these rows are
 * covered in auditLog.test.ts — here they are just data.
 */
async function seedEvents(
  projectId: string,
  specs: Array<{
    type?: string;
    userId?: string | null;
    metadata?: Record<string, unknown>;
    at?: Date;
  }>,
) {
  const base = Date.now();
  const created: string[] = [];

  for (const [index, spec] of specs.entries()) {
    const row = await prisma.securityEvent.create({
      data: {
        project_id: projectId,
        event_type: (spec.type ?? "LOGIN_SUCCESS") as SecurityEventType,
        severity: "INFO",
        user_id: spec.userId ?? null,
        metadata: (spec.metadata ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        created_at: spec.at ?? new Date(base + index * 1000),
      },
      select: { id: true },
    });
    created.push(row.id);
  }

  return created;
}

async function makeUser(projectId: string, email: string) {
  const user = await prisma.user.create({
    data: { project_id: projectId, email },
    select: { id: true },
  });

  return user.id;
}

const SESSION_SUMMARY_KEYS = [
  "id",
  "userId",
  "status",
  "deviceId",
  "deviceName",
  "deviceType",
  "osName",
  "osVersion",
  "browserName",
  "browserVersion",
  "ipCreated",
  "ipLast",
  "countryCreated",
  "countryLast",
  "cityCreated",
  "cityLast",
  "createdAt",
  "lastUsedAt",
  "expiresAt",
].sort();

/**
 * Direct inserts, like `seedEvents`: a test controls the count, the owner, the
 * status, and the ordering key. `status` defaults to `ACTIVE`.
 */
async function seedSessions(
  projectId: string,
  specs: Array<{
    userId: string;
    status?: "ACTIVE" | "REVOKED";
    at?: Date;
  }>,
) {
  const base = Date.now();
  const created: string[] = [];

  for (const [index, spec] of specs.entries()) {
    const row = await prisma.session.create({
      data: {
        project_id: projectId,
        user_id: spec.userId,
        status: spec.status ?? "ACTIVE",
        expires_at: new Date(base + 30 * 24 * 60 * 60 * 1000),
        created_at: spec.at ?? new Date(base + index * 1000),
        last_used_at: spec.at ?? new Date(base + index * 1000),
      },
      select: { id: true },
    });
    created.push(row.id);
  }

  return created;
}

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(async () => {
  await resetDatabase();
  await ensurePlatformProject();
});

describe("GET /projects/:projectId/events — owner session", () => {
  it("returns the Project's events newest first in the documented shape", async () => {
    const { project, developer } = await createOwnedProject();
    await seedEvents(project.id, [
      { type: "USER_REGISTERED", at: new Date(Date.now() - 3000) },
      { type: "LOGIN_SUCCESS", at: new Date(Date.now() - 2000) },
      {
        type: "OAUTH_ACCOUNT_LINKED",
        at: new Date(Date.now() - 1000),
        metadata: { provider: "google" },
      },
    ]);

    const response = await api("GET", `/projects/${project.id}/events`, {
      accessToken: developer.accessToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.events).toHaveLength(3);
    expect(response.body.events.map((e: any) => e.eventType)).toEqual([
      "OAUTH_ACCOUNT_LINKED",
      "LOGIN_SUCCESS",
      "USER_REGISTERED",
    ]);
    expect(Object.keys(response.body.events[0]).sort()).toEqual(EVENT_KEYS);
    // metadata is returned exactly as stored.
    expect(response.body.events[0].metadata).toEqual({ provider: "google" });
  });

  it("only ever shows the owner's own Project — never a second Project's", async () => {
    const { project, developer } = await createOwnedProject();
    await seedEvents(project.id, [{ type: "LOGIN_SUCCESS" }]);

    const other = await createOwnedProject();
    await seedEvents(other.project.id, [
      { type: "LOGIN_FAILED" },
      { type: "PASSWORD_CHANGED" },
    ]);

    const response = await api("GET", `/projects/${project.id}/events`, {
      accessToken: developer.accessToken,
    });

    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0].eventType).toBe("LOGIN_SUCCESS");
  });

  it("filters by ?eventType= — single and comma-separated", async () => {
    const { project, developer } = await createOwnedProject();
    await seedEvents(project.id, [
      { type: "LOGIN_SUCCESS" },
      { type: "LOGIN_FAILED" },
      { type: "LOGIN_FAILED" },
      { type: "PASSWORD_CHANGED" },
    ]);

    const single = await api(
      "GET",
      `/projects/${project.id}/events?eventType=LOGIN_FAILED`,
      { accessToken: developer.accessToken },
    );
    expect(single.body.events).toHaveLength(2);
    expect(
      single.body.events.every((e: any) => e.eventType === "LOGIN_FAILED"),
    ).toBe(true);

    const multi = await api(
      "GET",
      `/projects/${project.id}/events?eventType=LOGIN_FAILED,PASSWORD_CHANGED`,
      { accessToken: developer.accessToken },
    );
    expect(multi.body.events).toHaveLength(3);
  });

  it("400s an unknown ?eventType=", async () => {
    const { project, developer } = await createOwnedProject();

    const response = await api(
      "GET",
      `/projects/${project.id}/events?eventType=NOT_A_REAL_EVENT`,
      { accessToken: developer.accessToken },
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("event_type_invalid");
  });

  it("filters by ?userId= and 400s a malformed one", async () => {
    const { project, developer } = await createOwnedProject();
    const userA = await makeUser(project.id, "a@example.com");
    const userB = await makeUser(project.id, "b@example.com");
    await seedEvents(project.id, [
      { type: "LOGIN_SUCCESS", userId: userA },
      { type: "LOGIN_SUCCESS", userId: userB },
      { type: "LOGIN_FAILED", userId: userA },
    ]);

    const filtered = await api(
      "GET",
      `/projects/${project.id}/events?userId=${userA}`,
      { accessToken: developer.accessToken },
    );
    expect(filtered.body.events).toHaveLength(2);
    expect(filtered.body.events.every((e: any) => e.userId === userA)).toBe(
      true,
    );

    const malformed = await api(
      "GET",
      `/projects/${project.id}/events?userId=not-a-uuid`,
      { accessToken: developer.accessToken },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("user_id_invalid");
  });

  it("keyset-paginates: disjoint pages reassemble to the full ordered set", async () => {
    const { project, developer } = await createOwnedProject();
    const base = Date.now();
    await seedEvents(
      project.id,
      Array.from({ length: 25 }, (_, i) => ({
        type: "LOGIN_SUCCESS",
        at: new Date(base + i * 1000),
      })),
    );

    const ordered = (
      await prisma.securityEvent.findMany({
        where: { project_id: project.id },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        select: { id: true },
      })
    ).map((row) => row.id);

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const path: string =
        `/projects/${project.id}/events?limit=10` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const response = await api("GET", path, {
        accessToken: developer.accessToken,
      });

      expect(response.body.events.length).toBeLessThanOrEqual(10);
      walked.push(...response.body.events.map((e: any) => e.id));
      cursor = response.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(walked).toEqual(ordered);
    expect(new Set(walked).size).toBe(25);
  });

  it("400s a garbage ?cursor=", async () => {
    const { project, developer } = await createOwnedProject();

    for (const cursor of ["not-base64-!!", btoa('{"x":1}')]) {
      const response = await api(
        "GET",
        `/projects/${project.id}/events?cursor=${encodeURIComponent(cursor)}`,
        { accessToken: developer.accessToken },
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("cursor_invalid");
    }
  });

  it("clamps ?limit= to at least 1", async () => {
    const { project, developer } = await createOwnedProject();
    await seedEvents(project.id, [
      { type: "LOGIN_SUCCESS" },
      { type: "LOGIN_SUCCESS" },
      { type: "LOGIN_SUCCESS" },
    ]);

    const response = await api(
      "GET",
      `/projects/${project.id}/events?limit=0`,
      { accessToken: developer.accessToken },
    );

    expect(response.body.events).toHaveLength(1);
    expect(response.body.nextCursor).not.toBeNull();
  });

  /**
   * Mutation check: drop the `owner_id: userId` condition from
   * `requireProjectOwnership`'s `findFirst` (middlewares/projectOwnership.ts)
   * and re-run — this must fail, because developer A would then read
   * developer B's Project events. Restore afterward.
   */
  it("404s the owner of Project A asking for Project B's events", async () => {
    const a = await createOwnedProject();
    const b = await createOwnedProject();
    await seedEvents(b.project.id, [{ type: "LOGIN_SUCCESS" }]);

    const response = await api("GET", `/projects/${b.project.id}/events`, {
      accessToken: a.developer.accessToken,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");
  });

  it("404s an unknown Project id the same as one that is not mine", async () => {
    const { developer } = await createOwnedProject();

    const response = await api(
      "GET",
      "/projects/11111111-2222-4333-8444-555555555555/events",
      { accessToken: developer.accessToken },
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");
  });

  it("401s a request bearing only an API key — keys never reach the owner surface", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKey(developer.accessToken, project.id, "SECRET");

    const response = await api("GET", `/projects/${project.id}/events`, {
      headers: { "x-api-key": secret },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_missing");
  });
});

describe("GET /project/events — secret key", () => {
  it("returns the key's Project events in the same shape as the owner route", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKey(developer.accessToken, project.id, "SECRET");
    const seeded = await seedEvents(project.id, [
      { type: "USER_REGISTERED", at: new Date(Date.now() + 1000) },
      { type: "LOGIN_SUCCESS", at: new Date(Date.now() + 2000) },
    ]);

    const response = await api("GET", "/project/events", { apiKey: secret });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.events[0]).sort()).toEqual(EVENT_KEYS);
    expect(response.body).toHaveProperty("nextCursor");
    // Issuing the secret key above also wrote an API_KEY_ISSUED event into the
    // Project — the endpoint correctly surfaces it alongside the seeded rows.
    const returnedIds = response.body.events.map((e: any) => e.id);
    for (const id of seeded) {
      expect(returnedIds).toContain(id);
    }
  });

  /**
   * Mutation check: drop the `project_id: projectId` filter from
   * `listProjectEvents` (lib/projectManagement.ts) and re-run — this must
   * fail, because key A would then read Project B's events. Restore afterward.
   */
  it("is scoped to the key's own Project — a second Project's events never appear", async () => {
    const a = await createOwnedProject();
    const aKey = await issueKey(a.developer.accessToken, a.project.id, "SECRET");
    const aEvents = await seedEvents(a.project.id, [
      { type: "LOGIN_SUCCESS" },
      { type: "LOGIN_FAILED" },
    ]);

    const b = await createOwnedProject();
    const bEvents = await seedEvents(b.project.id, [
      { type: "PASSWORD_CHANGED" },
    ]);

    const response = await api("GET", "/project/events", { apiKey: aKey });

    const ids = response.body.events.map((e: any) => e.id);
    for (const aId of aEvents) {
      expect(ids).toContain(aId);
    }
    for (const bId of bEvents) {
      expect(ids).not.toContain(bId);
    }
  });

  it("403s a publishable key", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKey(
      developer.accessToken,
      project.id,
      "PUBLISHABLE",
    );

    const response = await api("GET", "/project/events", {
      apiKey: publishable,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("api_key_tier_forbidden");
  });

  it("supports the same filters and paging as the owner route", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKey(developer.accessToken, project.id, "SECRET");
    const base = Date.now();
    await seedEvents(project.id, [
      ...Array.from({ length: 12 }, (_, i) => ({
        type: "LOGIN_SUCCESS",
        at: new Date(base + i * 1000),
      })),
      { type: "LOGIN_FAILED", at: new Date(base + 20_000) },
    ]);

    const filtered = await api(
      "GET",
      "/project/events?eventType=LOGIN_FAILED",
      { apiKey: secret },
    );
    expect(filtered.body.events).toHaveLength(1);

    const firstPage = await api("GET", "/project/events?limit=10", {
      apiKey: secret,
    });
    expect(firstPage.body.events).toHaveLength(10);
    expect(firstPage.body.nextCursor).not.toBeNull();
  });
});

describe("GET /projects/:projectId/users — owner session", () => {
  it("lists the Project's users in the documented shape, oldest first", async () => {
    const { project, developer } = await createOwnedProject();
    const first = await prisma.user.create({
      data: {
        project_id: project.id,
        email: "first@example.com",
        username: "first",
        created_at: new Date(Date.now() - 2000),
      },
      select: { id: true },
    });
    const second = await prisma.user.create({
      data: {
        project_id: project.id,
        email: "second@example.com",
        created_at: new Date(Date.now() - 1000),
      },
      select: { id: true },
    });

    const other = await createOwnedProject();
    await makeUser(other.project.id, "stranger@example.com");

    const response = await api("GET", `/projects/${project.id}/users`, {
      accessToken: developer.accessToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.users.map((u: any) => u.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(Object.keys(response.body.users[0]).sort()).toEqual(
      ["id", "email", "username", "emailVerified", "role", "createdAt"].sort(),
    );
  });

  it("401s a request bearing only an API key", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKey(developer.accessToken, project.id, "SECRET");

    const response = await api("GET", `/projects/${project.id}/users`, {
      headers: { "x-api-key": secret },
    });

    expect(response.status).toBe(401);
  });
});

describe("GET /projects/:projectId/sessions — owner session", () => {
  it("returns the Project's ACTIVE sessions newest first in the documented shape", async () => {
    const { project, developer } = await createOwnedProject();
    const user = await makeUser(project.id, "u@example.com");
    const seeded = await seedSessions(project.id, [
      { userId: user, at: new Date(Date.now() - 3000) },
      { userId: user, at: new Date(Date.now() - 2000) },
      { userId: user, at: new Date(Date.now() - 1000), status: "REVOKED" },
    ]);

    const response = await api("GET", `/projects/${project.id}/sessions`, {
      accessToken: developer.accessToken,
    });

    expect(response.status).toBe(200);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.sessions.map((s: any) => s.id)).toEqual([
      seeded[1],
      seeded[0],
    ]);
    expect(Object.keys(response.body.sessions[0]).sort()).toEqual(
      SESSION_SUMMARY_KEYS,
    );
    expect(response.body.sessions[0].status).toBe("ACTIVE");
  });

  it("only ever shows the owner's own Project", async () => {
    const { project, developer } = await createOwnedProject();
    const mine = await makeUser(project.id, "mine@example.com");
    await seedSessions(project.id, [{ userId: mine }]);

    const other = await createOwnedProject();
    const theirs = await makeUser(other.project.id, "theirs@example.com");
    await seedSessions(other.project.id, [{ userId: theirs }, { userId: theirs }]);

    const response = await api("GET", `/projects/${project.id}/sessions`, {
      accessToken: developer.accessToken,
    });

    expect(response.body.sessions).toHaveLength(1);
    expect(response.body.sessions[0].userId).toBe(mine);
  });

  it("filters by ?userId= and 400s a malformed one", async () => {
    const { project, developer } = await createOwnedProject();
    const userA = await makeUser(project.id, "a@example.com");
    const userB = await makeUser(project.id, "b@example.com");
    await seedSessions(project.id, [
      { userId: userA },
      { userId: userA },
      { userId: userB },
    ]);

    const filtered = await api(
      "GET",
      `/projects/${project.id}/sessions?userId=${userA}`,
      { accessToken: developer.accessToken },
    );
    expect(filtered.body.sessions).toHaveLength(2);
    expect(filtered.body.sessions.every((s: any) => s.userId === userA)).toBe(
      true,
    );

    const malformed = await api(
      "GET",
      `/projects/${project.id}/sessions?userId=not-a-uuid`,
      { accessToken: developer.accessToken },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("user_id_invalid");
  });

  it("keyset-paginates: disjoint pages reassemble to the full ordered set", async () => {
    const { project, developer } = await createOwnedProject();
    const user = await makeUser(project.id, "walker@example.com");
    const base = Date.now();
    await seedSessions(
      project.id,
      Array.from({ length: 12 }, (_, i) => ({
        userId: user,
        at: new Date(base + i * 1000),
      })),
    );

    const ordered = (
      await prisma.session.findMany({
        where: { project_id: project.id },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        select: { id: true },
      })
    ).map((row) => row.id);

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const path: string =
        `/projects/${project.id}/sessions?limit=5` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const response = await api("GET", path, {
        accessToken: developer.accessToken,
      });
      expect(response.body.sessions.length).toBeLessThanOrEqual(5);
      walked.push(...response.body.sessions.map((s: any) => s.id));
      cursor = response.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(walked).toEqual(ordered);
    expect(new Set(walked).size).toBe(12);
  });

  /**
   * Mutation check: drop the `owner_id: userId` condition from
   * `requireProjectOwnership` and re-run — developer A would then read
   * developer B's sessions and this must fail.
   */
  it("404s the owner of Project A asking for Project B's routes", async () => {
    const a = await createOwnedProject();
    const b = await createOwnedProject();
    const bUser = await makeUser(b.project.id, "b-user@example.com");
    const [bSession] = await seedSessions(b.project.id, [{ userId: bUser }]);

    const routes: Array<[string, string]> = [
      ["GET", `/projects/${b.project.id}/users`],
      ["GET", `/projects/${b.project.id}/sessions`],
      ["GET", `/projects/${b.project.id}/sessions/${bSession}`],
      ["DELETE", `/projects/${b.project.id}/sessions/${bSession}`],
      ["GET", `/projects/${b.project.id}/events`],
    ];

    for (const [method, path] of routes) {
      const response = await api(method, path, {
        accessToken: a.developer.accessToken,
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("project_not_found");
    }
  });
});

describe("GET /projects/:projectId/sessions/:sessionId — owner session", () => {
  it("returns one session scoped to the Project", async () => {
    const { project, developer } = await createOwnedProject();
    const user = await makeUser(project.id, "one@example.com");
    const [sessionId] = await seedSessions(project.id, [{ userId: user }]);

    const response = await api(
      "GET",
      `/projects/${project.id}/sessions/${sessionId}`,
      { accessToken: developer.accessToken },
    );

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(
      [
        "id",
        "userId",
        "status",
        "createdAt",
        "lastUsedAt",
        "expiresAt",
        "revokedAt",
      ].sort(),
    );
    expect(response.body.id).toBe(sessionId);
    expect(response.body.userId).toBe(user);
  });

  it("400s a malformed id and 404s a cross-Project id", async () => {
    const { project, developer } = await createOwnedProject();
    const other = await createOwnedProject();
    const otherUser = await makeUser(other.project.id, "x@example.com");
    const [crossId] = await seedSessions(other.project.id, [
      { userId: otherUser },
    ]);

    const malformed = await api(
      "GET",
      `/projects/${project.id}/sessions/not-a-uuid`,
      { accessToken: developer.accessToken },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("session_id_invalid");

    const cross = await api(
      "GET",
      `/projects/${project.id}/sessions/${crossId}`,
      { accessToken: developer.accessToken },
    );
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe("session_not_found");
  });
});

describe("DELETE /projects/:projectId/sessions/:sessionId — owner session", () => {
  it("revokes an ACTIVE session, audited with the owner as actor", async () => {
    const { project, developer } = await createOwnedProject();
    const user = await makeUser(project.id, "victim@example.com");
    const [sessionId] = await seedSessions(project.id, [{ userId: user }]);

    const response = await api(
      "DELETE",
      `/projects/${project.id}/sessions/${sessionId}`,
      { accessToken: developer.accessToken },
    );
    expect(response.status).toBe(200);

    const session = await prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(session.status).toBe("REVOKED");
    expect(session.revoked_reason).toBe("owner_revoked");

    const events = await prisma.securityEvent.findMany({
      where: { event_type: "SESSION_REVOKED", session_id: sessionId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      actor: "owner",
      actor_user_id: developer.userId,
    });

    const second = await api(
      "DELETE",
      `/projects/${project.id}/sessions/${sessionId}`,
      { accessToken: developer.accessToken },
    );
    expect(second.status).toBe(404);
  });

  it("404s revoking a session that belongs to another Project", async () => {
    const { project, developer } = await createOwnedProject();
    const other = await createOwnedProject();
    const otherUser = await makeUser(other.project.id, "elsewhere@example.com");
    const [crossId] = await seedSessions(other.project.id, [
      { userId: otherUser },
    ]);

    const response = await api(
      "DELETE",
      `/projects/${project.id}/sessions/${crossId}`,
      { accessToken: developer.accessToken },
    );
    expect(response.status).toBe(404);

    const untouched = await prisma.session.findUniqueOrThrow({
      where: { id: crossId },
    });
    expect(untouched.status).toBe("ACTIVE");
  });

  it("401s a request bearing only an API key — and so does PATCH /projects/:id", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKey(developer.accessToken, project.id, "SECRET");
    const user = await makeUser(project.id, "guarded@example.com");
    const [sessionId] = await seedSessions(project.id, [{ userId: user }]);

    const del = await api(
      "DELETE",
      `/projects/${project.id}/sessions/${sessionId}`,
      { headers: { "x-api-key": secret } },
    );
    expect(del.status).toBe(401);

    const patch = await api("PATCH", `/projects/${project.id}`, {
      headers: { "x-api-key": secret },
      body: { name: "renamed" },
    });
    expect(patch.status).toBe(401);
  });
});

describe("GET /project/sessions — secret key", () => {
  it("returns the key's Project ACTIVE sessions in the owner shape", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKey(developer.accessToken, project.id, "SECRET");
    const user = await makeUser(project.id, "keyed@example.com");
    const seeded = await seedSessions(project.id, [
      { userId: user, at: new Date(Date.now() - 2000) },
      { userId: user, at: new Date(Date.now() - 1000) },
      { userId: user, at: new Date(), status: "REVOKED" },
    ]);

    const response = await api("GET", "/project/sessions", { apiKey: secret });

    expect(response.status).toBe(200);
    expect(response.body.sessions.map((s: any) => s.id)).toEqual([
      seeded[1],
      seeded[0],
    ]);
    expect(Object.keys(response.body.sessions[0]).sort()).toEqual(
      SESSION_SUMMARY_KEYS,
    );
    expect(response.body).toHaveProperty("nextCursor");
  });

  /**
   * Mutation check: drop the `project_id: projectId` filter from
   * `listProjectSessions` (lib/projectManagement.ts) and re-run — key A would
   * then see Project B's sessions and this must fail.
   */
  it("is scoped to the key's own Project — a second Project's sessions never appear", async () => {
    const a = await createOwnedProject();
    const aKey = await issueKey(a.developer.accessToken, a.project.id, "SECRET");
    const aUser = await makeUser(a.project.id, "a-user@example.com");
    const aSessions = await seedSessions(a.project.id, [
      { userId: aUser },
      { userId: aUser },
    ]);

    const b = await createOwnedProject();
    const bUser = await makeUser(b.project.id, "b-user@example.com");
    const bSessions = await seedSessions(b.project.id, [{ userId: bUser }]);

    const response = await api("GET", "/project/sessions", { apiKey: aKey });

    const ids = response.body.sessions.map((s: any) => s.id);
    for (const aId of aSessions) {
      expect(ids).toContain(aId);
    }
    for (const bId of bSessions) {
      expect(ids).not.toContain(bId);
    }
  });

  it("403s a publishable key", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKey(
      developer.accessToken,
      project.id,
      "PUBLISHABLE",
    );

    const response = await api("GET", "/project/sessions", {
      apiKey: publishable,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("api_key_tier_forbidden");
  });

  it("supports ?userId= and paging", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKey(developer.accessToken, project.id, "SECRET");
    const user = await makeUser(project.id, "pager@example.com");
    const base = Date.now();
    await seedSessions(
      project.id,
      Array.from({ length: 12 }, (_, i) => ({
        userId: user,
        at: new Date(base + i * 1000),
      })),
    );

    const firstPage = await api("GET", "/project/sessions?limit=10", {
      apiKey: secret,
    });
    expect(firstPage.body.sessions).toHaveLength(10);
    expect(firstPage.body.nextCursor).not.toBeNull();

    const filtered = await api(
      "GET",
      `/project/sessions?userId=${user}`,
      { apiKey: secret },
    );
    expect(filtered.body.sessions).toHaveLength(12);
  });
});
