import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { api, resetDatabase, startTestServer, stopTestServer } from "./helpers/api";
import { prisma } from "../lib/prisma";

const credentials = {
  email: "auditor@example.com",
  username: "auditor",
  password: "correct-horse-battery",
};

function eventTypes() {
  return prisma.securityEvent
    .findMany({ orderBy: { created_at: "asc" } })
    .then((events) => events.map((event) => event.event_type));
}

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);

describe("security event log", () => {
  it("records a registration and the confirmation email that follows it", async () => {
    await api("POST", "/register", { body: credentials });

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
    await api("POST", "/register", { body: credentials });
    await api("POST", "/login", {
      body: { email: credentials.email, password: "wrong-password-here" },
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
    });

    const failure = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "LOGIN_FAILED" },
    });

    expect(failure.user_id).toBeNull();
    expect(failure.metadata).toMatchObject({ reason: "unknown_account" });
  });

  it("records reuse detection at CRITICAL severity", async () => {
    const registered = await api("POST", "/register", { body: credentials });
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
    const registered = await api("POST", "/register", { body: credentials });

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

  it("never writes credentials into event metadata", async () => {
    await api("POST", "/register", { body: credentials });
    await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
    });

    const events = await prisma.securityEvent.findMany();
    const serialised = JSON.stringify(events);

    expect(serialised).not.toContain(credentials.password);
  });
});
