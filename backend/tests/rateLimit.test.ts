import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { setRateLimitingEnabled } from "../middlewares/rateLimit";

let project: Awaited<ReturnType<typeof createTestProject>>;

/**
 * Limiters are disabled for the rest of the suite, so their counters are still
 * at zero when this file turns them on.
 */
beforeAll(async () => {
  await startTestServer();
  await resetDatabase();
  project = await createTestProject();
  setRateLimitingEnabled(true);
});

afterAll(async () => {
  setRateLimitingEnabled(false);
  await stopTestServer();
});

describe("login rate limiting", () => {
  it("locks out repeated failures for a single account", async () => {
    const email = "target@example.com";
    const attempt = () =>
      api("POST", "/login", {
        body: { email, password: "wrong-password-attempt" },
        projectId: project.id,
      });

    const statuses: number[] = [];

    for (let i = 0; i < 9; i += 1) {
      const response = await attempt();
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 8).every((status) => status === 401)).toBe(true);

    const final = statuses.at(-1);
    expect(final).toBe(429);
  });

  it("returns the shared error contract when limited", async () => {
    const response = await api("POST", "/login", {
      body: { email: "target@example.com", password: "wrong-password-attempt" },
      projectId: project.id,
    });

    expect(response.status).toBe(429);
    expect(response.body.error).toEqual({
      message: "Too many requests",
      code: "rate_limited",
    });
  });

  it("keys per account rather than per source address", async () => {
    const response = await api("POST", "/login", {
      body: { email: "bystander@example.com", password: "wrong-password-here" },
      projectId: project.id,
    });

    expect(response.status).toBe(401);
  });

  it("keys per project rather than sharing a bucket across projects", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });
    const email = "cross-project-target@example.com";
    const attempt = (targetProjectId: string) =>
      api("POST", "/login", {
        body: { email, password: "wrong-password-attempt" },
        projectId: targetProjectId,
      });

    // Exhaust the budget for this email in `project`.
    let limited = false;
    for (let i = 0; i < 9; i += 1) {
      const response = await attempt(project.id);
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);

    // The identical email in a different project must be unaffected.
    const response = await attempt(otherProject.id);
    expect(response.status).toBe(401);
  });
});
