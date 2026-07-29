import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { api, resetDatabase, startTestServer, stopTestServer } from "./helpers/api";
import { setRateLimitingEnabled } from "../middlewares/rateLimit";

/**
 * Limiters are disabled for the rest of the suite, so their counters are still
 * at zero when this file turns them on.
 */
beforeAll(async () => {
  await startTestServer();
  await resetDatabase();
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
    });

    expect(response.status).toBe(401);
  });
});
