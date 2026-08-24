import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createOwnedProject,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { ensurePlatformProject } from "../lib/platformProject";
import { PLATFORM_PROJECT_ID } from "../constants/platform";
import { hashPassword } from "../lib/passwords";
import config from "../config";
import { createMemoryMailer, setMailer } from "../lib/mail";

// The suites below assert on both sides of the default-floor boundary, so
// they read the deployment-wide value rather than re-stating it.
const DEFAULT_FLOOR = config.password_min_length;

const mailer = createMemoryMailer();

function tokenFromLastMail(to: string) {
  const mail = mailer.lastTo(to);
  const match = mail?.text.match(/token=(\S+)/);

  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function makeCredentials(prefix: string, password = "a-default-compliant-pass") {
  const suffix = crypto.randomUUID();
  return {
    email: `${prefix}-${suffix}@example.com`,
    username: `${prefix}-${suffix.slice(0, 8)}`,
    password,
  };
}

function registerInto(projectId: string, credentials: ReturnType<typeof makeCredentials>) {
  return api("POST", "/register", { body: credentials, projectId });
}

beforeAll(async () => {
  setMailer(mailer);
  await startTestServer();
});

afterAll(async () => {
  // A fresh in-memory transport, not the console one: other suites share this
  // process and would otherwise start printing their mail.
  setMailer(createMemoryMailer());
  await stopTestServer();
});

beforeEach(async () => {
  mailer.clear();
  await resetDatabase();
  await ensurePlatformProject();
});

describe("the global default floor", () => {
  it(`rejects a ${DEFAULT_FLOOR - 1}-character password at registration`, async () => {
    const project = await createTestProject();
    const credentials = makeCredentials("shorty", "x".repeat(DEFAULT_FLOOR - 1));

    const response = await registerInto(project.id, credentials);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("password_too_short");
  });

  it(`accepts exactly ${DEFAULT_FLOOR} characters`, async () => {
    const project = await createTestProject();
    const credentials = makeCredentials("edge", "x".repeat(DEFAULT_FLOOR));

    const response = await registerInto(project.id, credentials);

    expect(response.status).toBe(201);
  });

  it("enforces the same floor when changing a password", async () => {
    const project = await createTestProject();
    const credentials = makeCredentials("changer");

    const registered = await registerInto(project.id, credentials);

    const response = await api("POST", "/change-password", {
      accessToken: registered.body.accessToken,
      body: {
        currentPassword: credentials.password,
        newPassword: "too-short-pw",
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("password_too_short");
  });
});

describe("the per-project override", () => {
  it("lets a Project lower the effective floor for its own users", async () => {
    const project = await prisma.project.create({
      data: { name: "Lenient Project", min_password_length: 8 },
    });
    const credentials = makeCredentials("lenient", "eight-char");

    const response = await registerInto(project.id, credentials);

    expect(response.status).toBe(201);
  });

  it("still rejects anything below the Project's own floor", async () => {
    const project = await prisma.project.create({
      data: { name: "Strict Project", min_password_length: 20 },
    });
    const credentials = makeCredentials("strict", "nineteen-chars-x");

    const response = await registerInto(project.id, credentials);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("password_too_short");
  });

  it("enforces the Project's floor on the reset path using the token's project", async () => {
    const project = await prisma.project.create({
      data: { name: "Reset Floor Project", min_password_length: 8 },
    });
    const credentials = makeCredentials("resettable", "eight-char");
    await registerInto(project.id, credentials);

    await api("POST", "/forgot-password", {
      body: { email: credentials.email },
      projectId: project.id,
    });
    const token = tokenFromLastMail(credentials.email)!;

    const response = await api("POST", "/reset-password", {
      body: { token, password: "nine-char-pw" },
    });

    expect(response.status).toBe(200);
  });

  it("rejects a too-short reset even when the token itself is unknown", async () => {
    const response = await api("POST", "/reset-password", {
      body: { token: "no-such-token", password: "seven-char" },
    });

    // A short password answers identically whether the token exists or not,
    // so this endpoint leaks nothing about account existence. Token validity
    // itself is only ever probed by someone already holding the (256-bit,
    // unguessable) token.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("password_too_short");
  });
});

describe("login carries no length floor", () => {
  it("accepts a legacy credential shorter than today's policy", async () => {
    const project = await createTestProject();
    const legacyPassword = "legacy";
    const user = await prisma.user.create({
      data: {
        project_id: project.id,
        email: "legacy@example.com",
        username: "legacy",
      },
    });
    await prisma.account.create({
      data: {
        user_id: user.id,
        project_id: project.id,
        provider_id: "credential",
        account_id: user.id,
        password: await hashPassword(legacyPassword),
      },
    });

    const response = await api("POST", "/login", {
      body: { email: user.email, password: legacyPassword },
      projectId: project.id,
    });

    expect(response.status).toBe(200);
  });
});

describe("POST /projects accepts the password policy", () => {
  it("stores and echoes min_password_length when given", async () => {
    await ensurePlatformProject();
    const suffix = crypto.randomUUID();
    const registered = await api("POST", "/register", {
      body: {
        email: `dev-${suffix}@example.com`,
        username: `dev-${suffix.slice(0, 8)}`,
        password: "correct-horse-battery",
      },
      projectId: PLATFORM_PROJECT_ID,
    });

    const created = await api("POST", "/projects", {
      body: { name: "Policy Project", min_password_length: 12 },
      accessToken: registered.body.accessToken,
    });

    expect(created.status).toBe(201);
    expect(created.body.minPasswordLength).toBe(12);

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row.min_password_length).toBe(12);
  });

  it("leaves the policy unset when omitted", async () => {
    await ensurePlatformProject();
    const suffix = crypto.randomUUID();
    const registered = await api("POST", "/register", {
      body: {
        email: `dev-${suffix}@example.com`,
        username: `dev-${suffix.slice(0, 8)}`,
        password: "correct-horse-battery",
      },
      projectId: PLATFORM_PROJECT_ID,
    });

    const created = await api("POST", "/projects", {
      body: { name: "Default Policy Project" },
      accessToken: registered.body.accessToken,
    });

    expect(created.status).toBe(201);
    expect(created.body.minPasswordLength).toBeNull();
  });

  it("rejects out-of-bounds values", async () => {
    await ensurePlatformProject();
    const suffix = crypto.randomUUID();
    const registered = await api("POST", "/register", {
      body: {
        email: `dev-${suffix}@example.com`,
        username: `dev-${suffix.slice(0, 8)}`,
        password: "correct-horse-battery",
      },
      projectId: PLATFORM_PROJECT_ID,
    });

    for (const min_password_length of [7, 129, 8.5]) {
      const response = await api("POST", "/projects", {
        body: { name: "Bounds Project", min_password_length },
        accessToken: registered.body.accessToken,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation");
    }
  });
});

describe("PATCH /projects/:id", () => {
  it("lets the owner tighten the floor and enforces it immediately", async () => {
    const { project, developer } = await createOwnedProject();

    const updated = await api("PATCH", `/projects/${project.id}`, {
      accessToken: developer.accessToken,
      body: { min_password_length: 20 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.minPasswordLength).toBe(20);

    const nineteen = makeCredentials("tight", "nineteen-chars-x");
    const rejected = await registerInto(project.id, nineteen);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("password_too_short");

    const twenty = makeCredentials("tight-ok", "twenty-characters-ok!");
    const accepted = await registerInto(project.id, twenty);
    expect(accepted.status).toBe(201);

    // Lowering/tightening a floor is an auth-relevant transition, so it is
    // audited like every other one.
    const event = await prisma.securityEvent.findFirst({
      where: { event_type: "PROJECT_PASSWORD_POLICY_CHANGED" },
    });
    expect(event?.project_id).toBe(project.id);
  });

  it("lets the owner clear the override so the global default applies again", async () => {
    const { project, developer } = await createOwnedProject();

    await api("PATCH", `/projects/${project.id}`, {
      accessToken: developer.accessToken,
      body: { min_password_length: 8 },
    });

    const cleared = await api("PATCH", `/projects/${project.id}`, {
      accessToken: developer.accessToken,
      body: { min_password_length: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.minPasswordLength).toBeNull();

    const credentials = makeCredentials("cleared", "ten-characters");
    const response = await registerInto(project.id, credentials);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("password_too_short");
  });

  it("answers a non-owner with the same 404 as a missing project", async () => {
    const target = await createOwnedProject();
    const stranger = await createOwnedProject();

    const response = await api("PATCH", `/projects/${target.project.id}`, {
      accessToken: stranger.developer.accessToken,
      body: { min_password_length: 8 },
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");
  });

  it("requires a session, never an API key", async () => {
    const { project } = await createOwnedProject();

    const unauthenticated = await api("PATCH", `/projects/${project.id}`, {
      body: { min_password_length: 8 },
    });
    expect(unauthenticated.status).toBe(401);

    // A secret key speaks for the Project in key-scoped routes, but project
    // management is session-only: requireAuth runs before any ownership logic.
    const keyed = await api("PATCH", `/projects/${project.id}`, {
      apiKey: "kauth_sk_definitely-not-a-real-verifier",
      body: { min_password_length: 8 },
    });
    expect(keyed.status).toBe(401);
  });

  it("rejects malformed bodies", async () => {
    const { project, developer } = await createOwnedProject();

    const response = await api("PATCH", `/projects/${project.id}`, {
      accessToken: developer.accessToken,
      body: { min_password_length: "twelve" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation");
  });
});
