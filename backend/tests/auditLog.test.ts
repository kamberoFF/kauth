import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";

const credentials = {
  email: "auditor@example.com",
  username: "auditor",
  password: "correct-horse-battery",
};

let project: Awaited<ReturnType<typeof createTestProject>>;

function eventTypes() {
  return prisma.securityEvent
    .findMany({ orderBy: { created_at: "asc" } })
    .then((events) => events.map((event) => event.event_type));
}

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);
beforeEach(async () => {
  project = await createTestProject();
});

describe("security event log", () => {
  it("records a registration and the confirmation email that follows it", async () => {
    await api("POST", "/register", { body: credentials, projectId: project.id });

    expect(await eventTypes()).toEqual([
      "USER_REGISTERED",
      "EMAIL_CONFIRMATION_SENT",
    ]);

    const registered = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "USER_REGISTERED" },
    });

    expect(registered.severity).toBe("INFO");
    expect(registered.user_id).not.toBeNull();
    expect(registered.session_id).not.toBeNull();
  });

  it("records a failed login against a known account", async () => {
    await api("POST", "/register", { body: credentials, projectId: project.id });
    await api("POST", "/login", {
      body: { email: credentials.email, password: "wrong-password-here" },
      projectId: project.id,
    });

    const failure = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "LOGIN_FAILED" },
    });

    expect(failure.severity).toBe("WARNING");
    expect(failure.user_id).not.toBeNull();
    expect(failure.metadata).toMatchObject({ reason: "bad_password" });
  });

  it("records a failed login against an unknown account without a user id", async () => {
    await api("POST", "/login", {
      body: { email: "ghost@example.com", password: "wrong-password-here" },
      projectId: project.id,
    });

    const failure = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "LOGIN_FAILED" },
    });

    expect(failure.user_id).toBeNull();
    expect(failure.metadata).toMatchObject({ reason: "unknown_account" });
  });

  it("records reuse detection at CRITICAL severity", async () => {
    const registered = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });
    const first = registered.body.refreshToken as string;

    await api("POST", "/refresh", { body: { refreshToken: first } });
    await api("POST", "/refresh", { body: { refreshToken: first } });

    const reuse = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "REFRESH_REUSE_DETECTED" },
    });

    expect(reuse.severity).toBe("CRITICAL");
    expect(await eventTypes()).toContain("REFRESH_SUCCESS");
  });

  it("records a logout and keeps the revoked session referenced", async () => {
    const registered = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });

    await api("POST", "/logout", {
      accessToken: registered.body.accessToken,
    });

    const logout = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "LOGOUT" },
    });

    expect(logout.session_id).not.toBeNull();

    const session = await prisma.session.findUniqueOrThrow({
      where: { id: logout.session_id! },
    });
    expect(session.status).toBe("REVOKED");
    expect(session.revoked_reason).toBe("user_logout");
  });

  it("records a self-service session revocation", async () => {
    const OTHER_DEVICE_ID = "9f8e7d6c-5b4a-4392-8172-6f5e4d3c2b1a";
    const registered = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });
    await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: OTHER_DEVICE_ID,
      projectId: project.id,
    });
    const target = await prisma.session.findFirstOrThrow({
      where: { device_id: OTHER_DEVICE_ID },
    });

    await api("DELETE", `/sessions/${target.id}`, {
      accessToken: registered.body.accessToken,
    });

    const revoked = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "SESSION_REVOKED" },
    });

    expect(revoked.severity).toBe("WARNING");
    expect(revoked.session_id).toBe(target.id);
    expect(revoked.project_id).toBe(project.id);
  });

  it("records an account unlink", async () => {
    const registered = await api("POST", "/register", {
      body: credentials,
      projectId: project.id,
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { project_id_email: { project_id: project.id, email: credentials.email } },
    });
    await prisma.account.create({
      data: {
        user_id: user.id,
        project_id: project.id,
        provider_id: "google",
        account_id: "google-subject-123",
      },
    });

    await api("DELETE", "/accounts/google", {
      accessToken: registered.body.accessToken,
    });

    const unlinked = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "ACCOUNT_UNLINKED" },
    });

    expect(unlinked.severity).toBe("WARNING");
    expect(unlinked.metadata).toMatchObject({ provider: "google" });
  });

  it("never writes credentials into event metadata", async () => {
    await api("POST", "/register", { body: credentials, projectId: project.id });
    await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });

    const events = await prisma.securityEvent.findMany();
    const serialised = JSON.stringify(events);

    expect(serialised).not.toContain(credentials.password);
  });
});
