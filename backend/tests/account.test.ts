import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { createMemoryMailer, setMailer } from "../lib/mail";

const credentials = {
  email: "recovery@example.com",
  username: "recovery",
  password: "correct-horse-battery",
};

const mailer = createMemoryMailer();

let project: Awaited<ReturnType<typeof createTestProject>>;

function tokenFromLastMail(to: string) {
  const mail = mailer.lastTo(to);
  const match = mail?.text.match(/token=(\S+)/);

  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function registerUser() {
  return api("POST", "/register", { body: credentials, projectId: project.id });
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
  await resetDatabase();
  mailer.clear();
  project = await createTestProject();
});

describe("email verification", () => {
  it("sends a confirmation link on registration", async () => {
    await registerUser();

    const mail = mailer.lastTo(credentials.email);

    expect(mail?.subject).toBe("Confirm your email address");
    expect(tokenFromLastMail(credentials.email)).toBeString();
  });

  it("confirms the address and burns the token", async () => {
    await registerUser();
    const token = tokenFromLastMail(credentials.email)!;

    const confirmed = await api("POST", "/verify-email", { body: { token } });
    expect(confirmed.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({
      where: {
        project_id_email: { project_id: project.id, email: credentials.email },
      },
    });
    expect(user.email_verified).toBe(true);

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "EMAIL_CONFIRMED" },
    });
    expect(event.project_id).toBe(project.id);

    const replay = await api("POST", "/verify-email", { body: { token } });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("token_invalid");
  });

  it("rejects an unknown token", async () => {
    const response = await api("POST", "/verify-email", {
      body: { token: "definitely-not-a-real-token" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("token_invalid");
  });

  it("answers identically for an unregistered address and sends nothing", async () => {
    const response = await api("POST", "/send-verification-email", {
      body: { email: "nobody@example.com" },
      projectId: project.id,
    });

    expect(response.status).toBe(202);
    expect(mailer.sent).toHaveLength(0);
  });

  it("retires the previous link when a new one is requested", async () => {
    await registerUser();
    const first = tokenFromLastMail(credentials.email)!;

    await api("POST", "/send-verification-email", {
      body: { email: credentials.email },
      projectId: project.id,
    });
    const second = tokenFromLastMail(credentials.email)!;

    expect(second).not.toBe(first);

    const stale = await api("POST", "/verify-email", { body: { token: first } });
    expect(stale.status).toBe(400);

    const current = await api("POST", "/verify-email", {
      body: { token: second },
    });
    expect(current.status).toBe(200);
  });
});

describe("password reset", () => {
  const newPassword = "an-entirely-different-secret";

  async function requestReset() {
    await registerUser();
    mailer.clear();

    await api("POST", "/forgot-password", {
      body: { email: credentials.email },
      projectId: project.id,
    });

    return tokenFromLastMail(credentials.email)!;
  }

  it("emails a reset link for a credential account", async () => {
    const token = await requestReset();

    expect(mailer.lastTo(credentials.email)?.subject).toBe(
      "Reset your password",
    );
    expect(token).toBeString();
  });

  it("answers identically for an unregistered address", async () => {
    const response = await api("POST", "/forgot-password", {
      body: { email: "nobody@example.com" },
      projectId: project.id,
    });

    expect(response.status).toBe(202);
    expect(mailer.sent).toHaveLength(0);
  });

  it("replaces the password and lets the user sign in with it", async () => {
    const token = await requestReset();

    const reset = await api("POST", "/reset-password", {
      body: { token, password: newPassword },
    });
    expect(reset.status).toBe(200);

    const withOld = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: project.id,
    });
    expect(withOld.status).toBe(401);

    const withNew = await api("POST", "/login", {
      body: { email: credentials.email, password: newPassword },
      projectId: project.id,
    });
    expect(withNew.status).toBe(200);
  });

  it("revokes every existing session", async () => {
    const registered = await registerUser();
    mailer.clear();
    await api("POST", "/forgot-password", {
      body: { email: credentials.email },
      projectId: project.id,
    });
    const token = tokenFromLastMail(credentials.email)!;

    await api("POST", "/reset-password", {
      body: { token, password: newPassword },
    });

    const refreshed = await api("POST", "/refresh", {
      body: { refreshToken: registered.body.refreshToken },
    });
    expect(refreshed.status).toBe(401);

    const sessions = await prisma.session.findMany();
    expect(sessions.every((session) => session.status === "REVOKED")).toBe(true);
    expect(sessions[0]!.revoked_reason).toBe("password_reset");
  });

  it("treats a completed reset as proof of mailbox control", async () => {
    const token = await requestReset();

    await api("POST", "/reset-password", {
      body: { token, password: newPassword },
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: {
        project_id_email: { project_id: project.id, email: credentials.email },
      },
    });
    expect(user.email_verified).toBe(true);
  });

  it("is single use", async () => {
    const token = await requestReset();

    await api("POST", "/reset-password", {
      body: { token, password: newPassword },
    });

    const replay = await api("POST", "/reset-password", {
      body: { token, password: "yet-another-secret-value" },
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("token_invalid");
  });

  it("records the reset in the audit log", async () => {
    const token = await requestReset();

    await api("POST", "/reset-password", {
      body: { token, password: newPassword },
    });

    const events = await prisma.securityEvent.findMany({
      where: {
        event_type: { in: ["PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_COMPLETED"] },
      },
    });

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.project_id === project.id)).toBe(true);
  });
});

describe("password change", () => {
  const newPassword = "a-freshly-chosen-secret";

  it("requires the current password", async () => {
    const registered = await registerUser();

    const response = await api("POST", "/change-password", {
      accessToken: registered.body.accessToken,
      body: { currentPassword: "not-the-right-one", newPassword },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("auth_failed");

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "LOGIN_FAILED" },
    });
    expect(event.project_id).toBe(project.id);
    expect(event.metadata).toMatchObject({ action: "change_password" });
  });

  it("requires authentication", async () => {
    const response = await api("POST", "/change-password", {
      body: { currentPassword: credentials.password, newPassword },
    });

    expect(response.status).toBe(401);
  });

  it("replaces the password and revokes existing sessions", async () => {
    const registered = await registerUser();

    const response = await api("POST", "/change-password", {
      accessToken: registered.body.accessToken,
      body: { currentPassword: credentials.password, newPassword },
    });
    expect(response.status).toBe(200);

    const refreshed = await api("POST", "/refresh", {
      body: { refreshToken: registered.body.refreshToken },
    });
    expect(refreshed.status).toBe(401);

    const withNew = await api("POST", "/login", {
      body: { email: credentials.email, password: newPassword },
      projectId: project.id,
    });
    expect(withNew.status).toBe(200);

    const changed = await prisma.securityEvent.findFirst({
      where: { event_type: "PASSWORD_CHANGED" },
    });
    expect(changed).not.toBeNull();
    expect(changed!.project_id).toBe(project.id);
  });

  it("rejects a password past the bcrypt input limit", async () => {
    const registered = await registerUser();

    const response = await api("POST", "/change-password", {
      accessToken: registered.body.accessToken,
      body: {
        currentPassword: credentials.password,
        newPassword: "x".repeat(73),
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation");
  });
});

describe("GET /accounts", () => {
  it("requires authentication", async () => {
    const response = await api("GET", "/accounts");

    expect(response.status).toBe(401);
  });

  it("lists every linked provider for the caller", async () => {
    const registered = await registerUser();
    const user = await prisma.user.findUniqueOrThrow({
      where: { project_id_email: { project_id: project.id, email: credentials.email } },
    });
    // Bypasses the OAuth flow deliberately: this test is about listing, not linking.
    await prisma.account.create({
      data: {
        user_id: user.id,
        project_id: project.id,
        provider_id: "google",
        account_id: "google-subject-123",
        access_token: "should-never-be-returned",
      },
    });

    const response = await api("GET", "/accounts", { accessToken: registered.body.accessToken });

    expect(response.status).toBe(200);
    const providers = response.body.accounts.map((a: { providerId: string }) => a.providerId);
    expect(providers.sort()).toEqual(["credential", "google"]);
  });

  it("never returns credential or OAuth secrets", async () => {
    const registered = await registerUser();

    const response = await api("GET", "/accounts", { accessToken: registered.body.accessToken });
    const [account] = response.body.accounts;

    expect(Object.keys(account).sort()).toEqual(
      ["id", "providerId", "linkedAt", "updatedAt"].sort(),
    );
  });

  it("never leaks another project's linked accounts for the same email", async () => {
    const otherProject = await createTestProject({ name: "Other Project" });
    const registered = await registerUser();
    await api("POST", "/register", { body: credentials, projectId: otherProject.id });

    const response = await api("GET", "/accounts", { accessToken: registered.body.accessToken });

    expect(response.body.accounts).toHaveLength(1);
  });

  /**
   * Mutation check: temporarily drop `user_id` from the `where` clause in
   * `listLinkedAccounts` and re-run this test — it must fail, because the
   * caller would then see the other user's linked accounts in the same
   * project too. Restore afterward.
   */
  it("never leaks another user's linked accounts within the same project", async () => {
    const registered = await registerUser();
    await api("POST", "/register", {
      body: { email: "other@example.com", username: "other", password: credentials.password },
      projectId: project.id,
    });

    const response = await api("GET", "/accounts", { accessToken: registered.body.accessToken });

    expect(response.body.accounts).toHaveLength(1);
    expect(response.body.accounts[0].providerId).toBe("credential");
  });
});

describe("DELETE /accounts/:providerId", () => {
  it("requires authentication", async () => {
    const response = await api("DELETE", "/accounts/google");

    expect(response.status).toBe(401);
  });

  it("unlinks a provider that isn't the caller's only sign-in method", async () => {
    const registered = await registerUser();
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

    const response = await api("DELETE", "/accounts/google", {
      accessToken: registered.body.accessToken,
    });
    expect(response.status).toBe(200);

    const listed = await api("GET", "/accounts", { accessToken: registered.body.accessToken });
    expect(listed.body.accounts).toHaveLength(1);
    expect(listed.body.accounts[0].providerId).toBe("credential");

    const event = await prisma.securityEvent.findFirst({
      where: { event_type: "ACCOUNT_UNLINKED" },
    });
    expect(event).not.toBeNull();
    expect(event!.severity).toBe("WARNING");
  });

  it("404s for a provider the caller never linked", async () => {
    const registered = await registerUser();

    const response = await api("DELETE", "/accounts/github", {
      accessToken: registered.body.accessToken,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("account_not_found");
  });

  /**
   * Mutation check: temporarily loosen the guard in `unlinkAccount` from
   * `remaining <= 1` to `remaining === 0` and re-run this test — it must
   * fail, because the only remaining credential would then be deletable.
   * Restore afterward.
   */
  it("cannot unlink the only remaining sign-in method", async () => {
    const registered = await registerUser();

    const response = await api("DELETE", "/accounts/credential", {
      accessToken: registered.body.accessToken,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("only_sign_in_method");

    const remaining = await prisma.account.count({});
    expect(remaining).toBe(1);
  });

  it("cannot be raced down to zero by two concurrent unlinks", async () => {
    const registered = await registerUser();
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

    // Exactly two providers linked; firing both unlinks at once must never
    // let both pass the "at least one remains" guard.
    const [credentialResult, googleResult] = await Promise.all([
      api("DELETE", "/accounts/credential", { accessToken: registered.body.accessToken }),
      api("DELETE", "/accounts/google", { accessToken: registered.body.accessToken }),
    ]);

    const statuses = [credentialResult.status, googleResult.status].sort();
    expect(statuses).toEqual([200, 400]);

    const remaining = await prisma.account.count({ where: { user_id: user.id } });
    expect(remaining).toBe(1);
  });
});
