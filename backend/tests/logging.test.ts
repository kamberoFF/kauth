import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { createMemoryMailer, setMailer } from "../lib/mail";
import { logger } from "../lib/logger";

const credentials = {
  email: "logtest@example.com",
  username: "logtest",
  password: "correct-horse-battery",
};

const mailer = createMemoryMailer();

let project: Awaited<ReturnType<typeof createTestProject>>;

function tokenFromLastMail(to: string) {
  const match = mailer.lastTo(to)?.text.match(/token=(\S+)/);

  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * The logger always writes through `console.log` (see lib/logger.ts), so
 * capturing it here observes every level, not just a stderr subset.
 */
async function captureLogs<T>(fn: () => Promise<T>) {
  const raw: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    raw.push(String(args[0]));
  };

  let result: T;
  try {
    result = await fn();
  } finally {
    console.log = original;
  }

  const lines = raw
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line !== null);

  return { result, lines };
}

beforeAll(async () => {
  setMailer(mailer);
  await startTestServer();
});

afterAll(async () => {
  setMailer(createMemoryMailer());
  await stopTestServer();
});

beforeEach(resetDatabase);
beforeEach(async () => {
  project = await createTestProject();
});

describe("structured request logging", () => {
  it("logs a correlated, well-formed line per request", async () => {
    const { result, lines } = await captureLogs(() => api("GET", "/health"));

    expect(result.status).toBe(200);

    const line = lines.find((l) => l.msg === "request completed");
    expect(line).toBeDefined();
    expect(line?.level).toBe("info");
    expect(typeof line?.requestId).toBe("string");
    expect((line?.requestId as string).length).toBeGreaterThan(0);
    expect(line?.route).toBe("/health");
    expect(line?.statusCode).toBe(200);
    expect(line?.userId).toBeUndefined();
    expect(line?.sessionId).toBeUndefined();
  });

  it("includes user id and session id once authenticated", async () => {
    const registered = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });

    const { lines } = await captureLogs(() =>
      api("GET", "/protected", { accessToken: registered.body.accessToken }),
    );

    const line = lines.find(
      (l) => l.msg === "request completed" && l.route === "/protected",
    );

    expect(line?.userId).toBe(registered.body.user.id);
    expect(line?.sessionId).toBeDefined();
  });

  it("omits user id and session id for an unauthenticated request", async () => {
    const { lines } = await captureLogs(() => api("GET", "/protected"));

    const line = lines.find(
      (l) => l.msg === "request completed" && l.route === "/protected",
    );

    expect(line?.statusCode).toBe(401);
    expect(line?.userId).toBeUndefined();
    expect(line?.sessionId).toBeUndefined();
  });

  it("logs a request that errors through the error handler too", async () => {
    const { lines } = await captureLogs(() =>
      api("GET", "/this-route-does-not-exist"),
    );

    const line = lines.find((l) => l.msg === "request completed");
    expect(line?.statusCode).toBe(404);
    expect(line?.level).toBe("warn");
  });
});

describe("log level filtering", () => {
  it("suppresses debug lines at the default info level", async () => {
    const { lines } = await captureLogs(async () => {
      logger.debug("should not appear");
      logger.info("should appear");
    });

    expect(lines.some((l) => l.msg === "should not appear")).toBe(false);
    expect(lines.some((l) => l.msg === "should appear")).toBe(true);
  });
});

describe("application logs never carry secrets", () => {
  it("never logs the audit trail's own event data", async () => {
    const { lines } = await captureLogs(() =>
      api("POST", "/register", { body: credentials, projectId: project.id }),
    );

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("USER_REGISTERED");
    expect(serialized).not.toContain(credentials.password);
  });

  it("never logs a verification token minted during the request", async () => {
    const { lines } = await captureLogs(() =>
      api("POST", "/register", { body: credentials, projectId: project.id }),
    );

    const token = tokenFromLastMail(credentials.email);
    expect(token).toBeDefined();

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(token as string);
  });
});
