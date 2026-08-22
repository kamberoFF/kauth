import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import config from "../config";

const credentials = {
  email: "csrf@example.com",
  username: "csrfuser",
  password: "correct-horse-battery",
};

const TRUSTED_ORIGIN = config.frontend_url;
const HOSTILE_ORIGIN = "https://evil.example";

let project: Awaited<ReturnType<typeof createTestProject>>;

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);
beforeEach(async () => {
  project = await createTestProject();
});

describe("origin validation", () => {
  it("allows a state-changing request from a trusted origin", async () => {
    const response = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
      headers: { origin: TRUSTED_ORIGIN },
    });

    expect(response.status).toBe(201);
  });

  it("rejects a state-changing request from an untrusted origin", async () => {
    const response = await api("POST", "/register", {
      body: credentials,
      headers: { origin: HOSTILE_ORIGIN },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("untrusted_origin");
  });

  it("logs the rejected origin", async () => {
    await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      headers: { origin: HOSTILE_ORIGIN },
    });

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "SUSPICIOUS_ACTIVITY" },
    });

    expect(event.metadata).toMatchObject({
      reason: "untrusted_origin",
      origin: HOSTILE_ORIGIN,
    });
  });

  it("falls back to the referer when no origin is sent", async () => {
    const response = await api("POST", "/register", {
      body: credentials,
      headers: { referer: `${HOSTILE_ORIGIN}/attack.html` },
    });

    expect(response.status).toBe(403);
  });

  it("allows non-browser clients that send no origin at all", async () => {
    const response = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });

    expect(response.status).toBe(201);
  });

  it("rejects a request that declares itself cross-site via fetch metadata", async () => {
    const response = await api("POST", "/register", {
      body: credentials,
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("untrusted_origin");
  });

  it("leaves safe methods alone", async () => {
    const response = await api("GET", "/health", {
      headers: { origin: HOSTILE_ORIGIN },
    });

    expect(response.status).toBe(200);
  });
});

describe("csrf double submit", () => {
  async function issuedToken() {
    const response = await api("GET", "/csrf-token");
    const setCookie = response.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";

    return { token: response.body.csrfToken as string, cookie };
  }

  it("issues a signed token and cookie", async () => {
    const { token, cookie } = await issuedToken();

    expect(token.split(".")).toHaveLength(2);
    expect(cookie).toContain("kauth_csrf=");
  });

  it("accepts a request whose header matches the cookie", async () => {
    const { token, cookie } = await issuedToken();

    const response = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
      headers: { cookie, "x-csrf-token": token },
    });

    expect(response.status).toBe(201);
  });

  it("rejects a cookie-bearing request with no token header", async () => {
    const { cookie } = await issuedToken();

    const response = await api("POST", "/register", {
      body: credentials,
      headers: { cookie },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("csrf_invalid");
  });

  it("rejects a header that does not match the cookie", async () => {
    const { cookie } = await issuedToken();
    const other = await issuedToken();

    const response = await api("POST", "/register", {
      body: credentials,
      headers: { cookie, "x-csrf-token": other.token },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("csrf_invalid");
  });

  it("rejects an unsigned token the attacker made up", async () => {
    const forged = "forgedtokenvalue.forgedsignaturevalue";

    const response = await api("POST", "/register", {
      body: credentials,
      headers: {
        cookie: `kauth_csrf=${forged}`,
        "x-csrf-token": forged,
      },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("csrf_invalid");
  });

  it("records the failure in the audit log", async () => {
    const { cookie } = await issuedToken();

    await api("POST", "/register", { body: credentials, headers: { cookie } });

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "CSRF_VALIDATION_FAILED" },
    });

    expect(event.metadata).toMatchObject({ reason: "header_missing" });
  });

  it("does not apply to requests that carry no cookies", async () => {
    const response = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });

    expect(response.status).toBe(201);
  });
});
