import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { api, createOwnedProject, resetDatabase, startTestServer, stopTestServer } from "./helpers/api";
import { prisma } from "../lib/prisma";

function issueKey(accessToken: string, projectId: string, type: "PUBLISHABLE" | "SECRET") {
  return api("POST", `/projects/${projectId}/keys`, {
    body: { type },
    accessToken,
  });
}

function listKeys(accessToken: string, projectId: string) {
  return api("GET", `/projects/${projectId}/keys`, { accessToken });
}

function getKey(accessToken: string, projectId: string, keyId: string) {
  return api("GET", `/projects/${projectId}/keys/${keyId}`, { accessToken });
}

function revokeKey(accessToken: string, projectId: string, keyId: string) {
  return api("DELETE", `/projects/${projectId}/keys/${keyId}`, { accessToken });
}

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);

describe("POST /projects/:projectId/keys", () => {
  it("requires authentication", async () => {
    const { project } = await createOwnedProject();

    const response = await api("POST", `/projects/${project.id}/keys`, {
      body: { type: "PUBLISHABLE" },
    });

    expect(response.status).toBe(401);
  });

  it("lets the owner issue a publishable key", async () => {
    const { project, developer } = await createOwnedProject();

    const response = await issueKey(developer.accessToken, project.id, "PUBLISHABLE");

    expect(response.status).toBe(201);
    expect(response.body.type).toBe("PUBLISHABLE");
    expect(response.body.value).toStartWith("pk_");
    expect(response.body.prefix).toBe(response.body.value);

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(row.project_id).toBe(project.id);
    expect(row.key_value).toBe(response.body.value);
    expect(row.key_hash).toBeNull();
  });

  it("lets the owner issue a secret key", async () => {
    const { project, developer } = await createOwnedProject();

    const response = await issueKey(developer.accessToken, project.id, "SECRET");

    expect(response.status).toBe(201);
    expect(response.body.type).toBe("SECRET");
    expect(response.body.value).toStartWith("sk_");
    expect(response.body.value).toContain(".");

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(row.key_value).toBeNull();
    expect(row.key_hash).not.toBeNull();
    // The raw verifier never appears in the stored hash.
    const verifier = (response.body.value as string).split(".")[1];
    expect(row.key_hash).not.toContain(verifier);
  });

  it("rejects a request from a developer who does not own the project", async () => {
    const { project } = await createOwnedProject();
    const intruder = await createOwnedProject();

    const response = await issueKey(intruder.developer.accessToken, project.id, "PUBLISHABLE");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");

    const keys = await prisma.apiKey.findMany({ where: { project_id: project.id } });
    expect(keys).toHaveLength(0);
  });

  it("rejects an invalid key type", async () => {
    const { project, developer } = await createOwnedProject();

    const response = await api("POST", `/projects/${project.id}/keys`, {
      body: { type: "BOGUS" },
      accessToken: developer.accessToken,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation");
  });

  it("records an API_KEY_ISSUED audit event", async () => {
    const { project, developer } = await createOwnedProject();

    const response = await issueKey(developer.accessToken, project.id, "SECRET");

    const event = await prisma.securityEvent.findFirst({
      where: { event_type: "API_KEY_ISSUED", project_id: project.id },
    });
    expect(event).not.toBeNull();
    expect(event!.severity).toBe("INFO");
    expect(event!.user_id).toBe(developer.userId);
    expect((event!.metadata as Record<string, unknown>).apiKeyId).toBe(response.body.id);
  });
});

describe("GET /projects/:projectId/keys", () => {
  it("never includes the raw value for either tier", async () => {
    const { project, developer } = await createOwnedProject();
    await issueKey(developer.accessToken, project.id, "PUBLISHABLE");
    await issueKey(developer.accessToken, project.id, "SECRET");

    const response = await listKeys(developer.accessToken, project.id);

    expect(response.status).toBe(200);
    expect(response.body.keys).toHaveLength(2);
    for (const key of response.body.keys) {
      expect(key.value).toBeUndefined();
      expect(typeof key.prefix).toBe("string");
    }
  });

  /**
   * Mutation check: temporarily drop `project_id` from the `where` clause in
   * `listApiKeys` and re-run this test — it must fail, because the caller
   * would then see the other project's keys too. Restore afterward.
   */
  it("never leaks another project's keys", async () => {
    const { project, developer } = await createOwnedProject();
    const other = await createOwnedProject();
    await issueKey(developer.accessToken, project.id, "PUBLISHABLE");
    await issueKey(other.developer.accessToken, other.project.id, "PUBLISHABLE");

    const response = await listKeys(developer.accessToken, project.id);

    expect(response.body.keys).toHaveLength(1);
  });

  it("rejects a request from a non-owner", async () => {
    const { project } = await createOwnedProject();
    const intruder = await createOwnedProject();

    const response = await listKeys(intruder.developer.accessToken, project.id);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");
  });
});

describe("GET /projects/:projectId/keys/:keyId", () => {
  it("returns the full value again for a publishable key", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await issueKey(developer.accessToken, project.id, "PUBLISHABLE");

    const response = await getKey(developer.accessToken, project.id, issued.body.id);

    expect(response.status).toBe(200);
    expect(response.body.value).toBe(issued.body.value);
  });

  it("never returns the value again for a secret key", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await issueKey(developer.accessToken, project.id, "SECRET");

    const response = await getKey(developer.accessToken, project.id, issued.body.id);

    expect(response.status).toBe(200);
    expect(response.body.value).toBeNull();
  });

  it("rejects a request from a non-owner", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await issueKey(developer.accessToken, project.id, "PUBLISHABLE");
    const intruder = await createOwnedProject();

    const response = await getKey(intruder.developer.accessToken, project.id, issued.body.id);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");
  });

  it("404s on a well-formed but nonexistent key id", async () => {
    const { project, developer } = await createOwnedProject();

    const response = await getKey(
      developer.accessToken,
      project.id,
      "00000000-0000-4000-8000-000000000000",
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("api_key_not_found");
  });
});

describe("DELETE /projects/:projectId/keys/:keyId", () => {
  it("revokes a key without deleting its row", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await issueKey(developer.accessToken, project.id, "SECRET");

    const response = await revokeKey(developer.accessToken, project.id, issued.body.id);
    expect(response.status).toBe(200);

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: issued.body.id } });
    expect(row.revoked_at).not.toBeNull();
  });

  it("immediately rejects further requests bearing the revoked key", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await issueKey(developer.accessToken, project.id, "PUBLISHABLE");
    await revokeKey(developer.accessToken, project.id, issued.body.id);

    const response = await api("POST", "/register", {
      body: { email: "user@example.com", username: "user", password: "correct-horse-battery" },
      apiKey: issued.body.value,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("api_key_revoked");
  });

  it("404s on revoking an already-revoked key", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await issueKey(developer.accessToken, project.id, "SECRET");
    await revokeKey(developer.accessToken, project.id, issued.body.id);

    const response = await revokeKey(developer.accessToken, project.id, issued.body.id);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("api_key_not_found");
  });

  it("rejects a request from a non-owner and leaves the key active", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await issueKey(developer.accessToken, project.id, "PUBLISHABLE");
    const intruder = await createOwnedProject();

    const response = await revokeKey(intruder.developer.accessToken, project.id, issued.body.id);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: issued.body.id } });
    expect(row.revoked_at).toBeNull();
  });

  it("records an API_KEY_REVOKED audit event", async () => {
    const { project, developer } = await createOwnedProject();
    const issued = await issueKey(developer.accessToken, project.id, "SECRET");

    await revokeKey(developer.accessToken, project.id, issued.body.id);

    const event = await prisma.securityEvent.findFirst({
      where: { event_type: "API_KEY_REVOKED", project_id: project.id },
    });
    expect(event).not.toBeNull();
    expect(event!.severity).toBe("WARNING");
    expect(event!.user_id).toBe(developer.userId);
    expect((event!.metadata as Record<string, unknown>).apiKeyId).toBe(issued.body.id);
  });
});
