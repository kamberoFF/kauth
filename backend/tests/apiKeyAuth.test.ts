import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { api, createOwnedProject, resetDatabase, startTestServer, stopTestServer } from "./helpers/api";
import { prisma } from "../lib/prisma";

async function issueKeyValue(accessToken: string, projectId: string, type: "PUBLISHABLE" | "SECRET") {
  const response = await api("POST", `/projects/${projectId}/keys`, {
    body: { type },
    accessToken,
  });

  return response.body.value as string;
}

function registerEndUser(apiKey: string, email = "enduser@example.com") {
  return api("POST", "/register", {
    body: { email, username: "enduser", password: "correct-horse-battery" },
    apiKey,
  });
}

function loginEndUser(apiKey: string, email = "enduser@example.com") {
  return api("POST", "/login", {
    body: { email, password: "correct-horse-battery" },
    apiKey,
  });
}

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);

describe("publishable key", () => {
  it("can register an end user", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKeyValue(developer.accessToken, project.id, "PUBLISHABLE");

    const response = await registerEndUser(publishable);

    expect(response.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({
      where: { project_id_email: { project_id: project.id, email: "enduser@example.com" } },
    });
    expect(user.project_id).toBe(project.id);
  });

  it("can log an end user in", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKeyValue(developer.accessToken, project.id, "PUBLISHABLE");
    await registerEndUser(publishable);

    const response = await loginEndUser(publishable);

    expect(response.status).toBe(200);
  });

  it("is rejected from listing the project's users", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKeyValue(developer.accessToken, project.id, "PUBLISHABLE");

    const response = await api("GET", "/project/users", { apiKey: publishable });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("api_key_tier_forbidden");
  });

  it("is rejected from verifying a session", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKeyValue(developer.accessToken, project.id, "PUBLISHABLE");

    const response = await api(
      "GET",
      "/project/sessions/00000000-0000-4000-8000-000000000000",
      { apiKey: publishable },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("api_key_tier_forbidden");
  });

  it("is rejected from revoking a session", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKeyValue(developer.accessToken, project.id, "PUBLISHABLE");

    const response = await api(
      "DELETE",
      "/project/sessions/00000000-0000-4000-8000-000000000000",
      { apiKey: publishable },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("api_key_tier_forbidden");
  });

  it("is rejected from project-management actions", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKeyValue(developer.accessToken, project.id, "PUBLISHABLE");

    const response = await api("GET", `/projects/${project.id}/keys`, { apiKey: publishable });

    expect(response.status).toBe(401);
  });
});

describe("secret key", () => {
  it("can register and log in an end user", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKeyValue(developer.accessToken, project.id, "SECRET");

    const registered = await registerEndUser(secret);
    expect(registered.status).toBe(201);

    const loggedIn = await loginEndUser(secret);
    expect(loggedIn.status).toBe(200);
  });

  it("lists the project's users", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKeyValue(developer.accessToken, project.id, "SECRET");
    await registerEndUser(secret);

    const response = await api("GET", "/project/users", { apiKey: secret });

    expect(response.status).toBe(200);
    expect(response.body.users).toHaveLength(1);
    expect(response.body.users[0].email).toBe("enduser@example.com");
  });

  it("verifies a live session", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKeyValue(developer.accessToken, project.id, "SECRET");
    const registered = await registerEndUser(secret);

    const session = await prisma.session.findFirstOrThrow({
      where: { user_id: registered.body.user.id },
    });

    const response = await api("GET", `/project/sessions/${session.id}`, { apiKey: secret });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(session.id);
    expect(response.body.status).toBe("ACTIVE");
  });

  it("revokes a session, immediately invalidating its access token", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKeyValue(developer.accessToken, project.id, "SECRET");
    const registered = await registerEndUser(secret);

    const session = await prisma.session.findFirstOrThrow({
      where: { user_id: registered.body.user.id },
    });

    const response = await api("DELETE", `/project/sessions/${session.id}`, { apiKey: secret });
    expect(response.status).toBe(200);

    const revoked = await api("GET", "/protected", { accessToken: registered.body.accessToken });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe("session_revoked");

    const event = await prisma.securityEvent.findFirst({
      where: { event_type: "SESSION_REVOKED", session_id: session.id },
    });
    expect(event).not.toBeNull();
    expect(event!.user_id).toBe(registered.body.user.id);
  });

  it("is rejected from project-management actions", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKeyValue(developer.accessToken, project.id, "SECRET");

    const response = await api("GET", `/projects/${project.id}/keys`, { apiKey: secret });

    expect(response.status).toBe(401);
  });

  it("never reaches another project's users", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKeyValue(developer.accessToken, project.id, "SECRET");
    await registerEndUser(secret);

    const other = await createOwnedProject();
    const otherSecret = await issueKeyValue(other.developer.accessToken, other.project.id, "SECRET");
    await registerEndUser(otherSecret, "other-project-user@example.com");

    const response = await api("GET", "/project/users", { apiKey: secret });

    expect(response.body.users).toHaveLength(1);
    expect(response.body.users[0].email).toBe("enduser@example.com");
  });

  it("cannot verify or revoke a session belonging to another project", async () => {
    const other = await createOwnedProject();
    const otherSecret = await issueKeyValue(other.developer.accessToken, other.project.id, "SECRET");
    const otherRegistered = await registerEndUser(otherSecret, "other-project-user@example.com");
    const otherSession = await prisma.session.findFirstOrThrow({
      where: { user_id: otherRegistered.body.user.id },
    });

    const { project, developer } = await createOwnedProject();
    const secret = await issueKeyValue(developer.accessToken, project.id, "SECRET");

    const verify = await api("GET", `/project/sessions/${otherSession.id}`, { apiKey: secret });
    expect(verify.status).toBe(404);
    expect(verify.body.error.code).toBe("session_not_found");

    const revoke = await api("DELETE", `/project/sessions/${otherSession.id}`, { apiKey: secret });
    expect(revoke.status).toBe(404);
    expect(revoke.body.error.code).toBe("session_not_found");

    const row = await prisma.session.findUniqueOrThrow({ where: { id: otherSession.id } });
    expect(row.status).toBe("ACTIVE");
  });

  /**
   * Mutation check: temporarily remove the `key_type !== "SECRET"` branch in
   * `requireSecretKey` (middlewares/apiKey.ts) and re-run this test and the
   * "publishable key... is rejected from" tests above — they must all fail,
   * because a publishable key would then pass the elevated-ops gate too.
   * Restore afterward.
   */
  it("is the only tier that reaches elevated operations", async () => {
    const { project, developer } = await createOwnedProject();
    const publishable = await issueKeyValue(developer.accessToken, project.id, "PUBLISHABLE");
    const secret = await issueKeyValue(developer.accessToken, project.id, "SECRET");

    const withPublishable = await api("GET", "/project/users", { apiKey: publishable });
    const withSecret = await api("GET", "/project/users", { apiKey: secret });

    expect(withPublishable.status).toBe(403);
    expect(withSecret.status).toBe(200);
  });
});

describe("revoked and malformed keys", () => {
  it("rejects a revoked key with api_key_revoked, not api_key_invalid", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await api("POST", `/projects/${project.id}/keys`, {
      body: { type: "SECRET" },
      accessToken: developer.accessToken,
    });
    await api("DELETE", `/projects/${project.id}/keys/${issued.body.id}`, {
      accessToken: developer.accessToken,
    });

    const response = await api("GET", "/project/users", { apiKey: issued.body.value });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("api_key_revoked");
  });

  it("rejects an unknown key as api_key_invalid", async () => {
    const response = await api("GET", "/project/users", { apiKey: "sk_bogus.verifier" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("api_key_invalid");
  });

  it("rejects a missing key as api_key_missing on elevated routes", async () => {
    const response = await api("GET", "/project/users");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("api_key_missing");
  });
});

describe("project-management boundary", () => {
  /**
   * Mutation check: temporarily drop the `owner_id: userId` condition from
   * `requireProjectOwnership`'s `findFirst` (middlewares/projectOwnership.ts)
   * and re-run this test — it must fail, because any authenticated developer
   * (not just the owner) would then be able to issue keys for any project.
   * Restore afterward.
   */
  it("is enforced by session ownership, not merely by rejecting API keys", async () => {
    const { project } = await createOwnedProject();
    const someoneElse = await createOwnedProject();

    const response = await api("POST", `/projects/${project.id}/keys`, {
      body: { type: "PUBLISHABLE" },
      accessToken: someoneElse.developer.accessToken,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");
  });
});
