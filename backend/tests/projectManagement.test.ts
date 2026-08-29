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
