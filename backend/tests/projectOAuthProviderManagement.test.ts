import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createOwnedProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { decrypt } from "../lib/cryptoBox";
import { PROJECT_OAUTH_CONTEXT } from "../lib/oauth/providers";

// A real built-in id (its factory is registered unconditionally at module
// load), so no test-only provider registration is needed here.
const PROVIDER = "github";
const SECRET = "gh-super-secret-value";

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDatabase);

async function issueKey(
  accessToken: string,
  projectId: string,
  type: "PUBLISHABLE" | "SECRET",
) {
  const response = await api("POST", `/projects/${projectId}/keys`, {
    body: { type },
    accessToken,
  });
  return response.body.value as string;
}

function configChangeEvents(projectId: string) {
  return prisma.securityEvent.findMany({
    where: { project_id: projectId, event_type: "PROJECT_OAUTH_CONFIG_CHANGED" },
    orderBy: { created_at: "asc" },
  });
}

describe("owner Provider-app management", () => {
  it("lists inherited providers, then reflects an override, a disable, and a clear", async () => {
    const { project, developer } = await createOwnedProject();
    const auth = { accessToken: developer.accessToken };

    const initial = await api(
      "GET",
      `/projects/${project.id}/oauth/providers`,
      auth,
    );
    expect(initial.status).toBe(200);
    const githubInitial = initial.body.providers.find(
      (p: { provider: string }) => p.provider === PROVIDER,
    );
    expect(githubInitial).toEqual({
      provider: PROVIDER,
      source: "instance",
      enabled: false,
      clientId: null,
    });

    const configured = await api(
      "PUT",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      { ...auth, body: { clientId: "gh-client", clientSecret: SECRET } },
    );
    expect(configured.status).toBe(200);
    expect(configured.body).toEqual({
      provider: PROVIDER,
      source: "project",
      enabled: true,
      clientId: "gh-client",
    });

    // The effect is visible on the unauthenticated discovery endpoint...
    const discovery = await api(
      "GET",
      `/oauth/providers?projectId=${project.id}`,
    );
    expect(discovery.body.providers).toContain(PROVIDER);

    // ...and the authorization start now routes through the Project's client.
    const started = await api("GET", `/oauth/${PROVIDER}?projectId=${project.id}`, {
      redirect: "manual",
    });
    expect(started.status).toBe(302);
    expect(new URL(started.headers.get("location")!).searchParams.get("client_id")).toBe(
      "gh-client",
    );

    const disabled = await api(
      "PUT",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      { ...auth, body: { disabled: true } },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual({
      provider: PROVIDER,
      source: "project",
      enabled: false,
      clientId: null,
    });

    const afterDisable = await api(
      "GET",
      `/oauth/providers?projectId=${project.id}`,
    );
    expect(afterDisable.body.providers).not.toContain(PROVIDER);
    const forcedStart = await api(
      "GET",
      `/oauth/${PROVIDER}?projectId=${project.id}`,
      { redirect: "manual" },
    );
    expect(forcedStart.status).toBe(404);

    const cleared = await api(
      "DELETE",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      auth,
    );
    expect(cleared.status).toBe(200);

    const afterClear = await api(
      "GET",
      `/projects/${project.id}/oauth/providers`,
      auth,
    );
    expect(
      afterClear.body.providers.find(
        (p: { provider: string }) => p.provider === PROVIDER,
      ).source,
    ).toBe("instance");
    // Back to inherit: the OAuth flow now resolves against the instance, which
    // configured no github app in tests, so the start 404s (not the disabled
    // path — the owner GET above proves the row is gone).
    const inheritedStart = await api(
      "GET",
      `/oauth/${PROVIDER}?projectId=${project.id}`,
      { redirect: "manual" },
    );
    expect(inheritedStart.status).toBe(404);

    // A second DELETE has nothing to clear.
    const again = await api(
      "DELETE",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      auth,
    );
    expect(again.status).toBe(404);
  });

  it("rejects a malformed body and an unknown provider, and never echoes the secret", async () => {
    const { project, developer } = await createOwnedProject();
    const auth = { accessToken: developer.accessToken };

    const partial = await api(
      "PUT",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      { ...auth, body: { clientId: "only-id" } },
    );
    expect(partial.status).toBe(400);
    expect(partial.body.error.code).toBe("validation");

    const both = await api(
      "PUT",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      {
        ...auth,
        body: { clientId: "id", clientSecret: "s", disabled: true },
      },
    );
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe("validation");

    const unknown = await api(
      "PUT",
      `/projects/${project.id}/oauth/providers/twitter`,
      { ...auth, body: { clientId: "id", clientSecret: "s" } },
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("provider_not_found");

    await api("PUT", `/projects/${project.id}/oauth/providers/${PROVIDER}`, {
      ...auth,
      body: { clientId: "gh-client", clientSecret: SECRET },
    });

    const listing = await api(
      "GET",
      `/projects/${project.id}/oauth/providers`,
      auth,
    );
    expect(JSON.stringify(listing.body)).not.toContain(SECRET);
  });

  it("stores the secret encrypted at rest under the project-oauth context", async () => {
    const { project, developer } = await createOwnedProject();

    await api("PUT", `/projects/${project.id}/oauth/providers/${PROVIDER}`, {
      accessToken: developer.accessToken,
      body: { clientId: "gh-client", clientSecret: SECRET },
    });

    const row = await prisma.projectOAuthCredential.findFirstOrThrow({
      where: { project_id: project.id },
    });
    expect(row.client_secret_enc).not.toBe(SECRET);
    expect(row.client_secret_enc).not.toContain(SECRET);
    expect(decrypt(row.client_secret_enc!, PROJECT_OAUTH_CONTEXT)).toBe(SECRET);
  });

  it("writes exactly one config-change event per action, attributed and secret-free", async () => {
    const { project, developer } = await createOwnedProject();
    const auth = { accessToken: developer.accessToken };

    await api("PUT", `/projects/${project.id}/oauth/providers/${PROVIDER}`, {
      ...auth,
      body: { clientId: "gh-client", clientSecret: SECRET },
    });
    await api("PUT", `/projects/${project.id}/oauth/providers/${PROVIDER}`, {
      ...auth,
      body: { disabled: true },
    });
    await api(
      "DELETE",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      auth,
    );

    const events = await configChangeEvents(project.id);
    expect(events.map((e) => (e.metadata as { action: string }).action)).toEqual([
      "configured",
      "disabled",
      "cleared",
    ]);

    for (const event of events) {
      expect(event.severity).toBe("WARNING");
      expect(event.user_id).toBe(developer.userId);
      expect(event.project_id).toBe(project.id);
      const metadata = event.metadata as Record<string, unknown>;
      expect(metadata).toEqual({ provider: PROVIDER, action: metadata.action });
      expect(JSON.stringify(metadata)).not.toContain(SECRET);
      expect(JSON.stringify(metadata)).not.toContain("gh-client");
    }
  });
});

describe("Provider-app management is owner-session only", () => {
  it("404s every route for a non-owner developer session", async () => {
    const { project } = await createOwnedProject();
    const intruder = await createOwnedProject();
    const auth = { accessToken: intruder.developer.accessToken };

    // Mutation: dropping the owner_id filter in requireProjectOwnership makes
    // all three of these succeed.
    const get = await api(
      "GET",
      `/projects/${project.id}/oauth/providers`,
      auth,
    );
    expect(get.status).toBe(404);

    const put = await api(
      "PUT",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      { ...auth, body: { disabled: true } },
    );
    expect(put.status).toBe(404);

    const del = await api(
      "DELETE",
      `/projects/${project.id}/oauth/providers/${PROVIDER}`,
      auth,
    );
    expect(del.status).toBe(404);
  });

  it("401s every route for a request bearing only an API key", async () => {
    const { project, developer } = await createOwnedProject();
    const secret = await issueKey(developer.accessToken, project.id, "SECRET");
    const publishable = await issueKey(
      developer.accessToken,
      project.id,
      "PUBLISHABLE",
    );

    // Mutation: dropping `requireAuth` from any of these routes lets the
    // key-only request through to requireProjectOwnership and this fails —
    // a leaked SDK key must not reach Provider-app config (user story 19).
    for (const apiKey of [secret, publishable]) {
      expect(
        (await api("GET", `/projects/${project.id}/oauth/providers`, { apiKey }))
          .status,
      ).toBe(401);
      expect(
        (
          await api(
            "PUT",
            `/projects/${project.id}/oauth/providers/${PROVIDER}`,
            { apiKey, body: { disabled: true } },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await api(
            "DELETE",
            `/projects/${project.id}/oauth/providers/${PROVIDER}`,
            { apiKey },
          )
        ).status,
      ).toBe(401);
    }
  });
});
