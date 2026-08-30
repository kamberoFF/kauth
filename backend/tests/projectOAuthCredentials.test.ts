import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { OAuth2Tokens } from "arctic";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { encrypt, decrypt } from "../lib/cryptoBox";
import {
  registerOAuthProvider,
  registerOAuthProviderFactory,
  unregisterOAuthProvider,
  unregisterOAuthProviderFactory,
  PROJECT_OAUTH_CONTEXT,
  type OAuthCredentials,
  type OAuthProfile,
} from "../lib/oauth/providers";

const PROVIDER_ID = "stubproj";
const VALID_CODE = "valid-authorization-code";
const MFA_CONTEXT = "kauth:mfa-totp";

/**
 * Every `clientSecret` a constructed provider validated a code with, in call
 * order — the direct proof that a Project's *decrypted* secret reached
 * provider construction, not just that a redirect URL looked right.
 */
let validatedWithSecret: string[] = [];

const profile: OAuthProfile = {
  accountId: "stub-account-1",
  email: "social@example.com",
  emailVerified: true,
  name: "Ada Lovelace",
  image: "https://example.com/avatar.png",
};

/**
 * A provider whose authorization URL echoes the `client_id` it was built with
 * (so isolation is visible in the redirect `Location`) and whose code
 * validation records the `client_secret` it was built with.
 */
function stubProvider(credentials: OAuthCredentials) {
  return {
    id: PROVIDER_ID,
    scopes: ["email"],
    usesPkce: true,
    createAuthorizationURL: (state: string, codeVerifier: string) =>
      new URL(
        `https://provider.example/authorize?client_id=${encodeURIComponent(
          credentials.clientId,
        )}&state=${state}&code_challenge=${codeVerifier}`,
      ),
    async validateAuthorizationCode(code: string) {
      validatedWithSecret.push(credentials.clientSecret);

      if (code !== VALID_CODE) {
        throw new Error("invalid authorization code");
      }

      return new OAuth2Tokens({
        access_token: "stub-access-token",
        token_type: "bearer",
      });
    },
    async fetchProfile() {
      return profile;
    },
  };
}

beforeAll(async () => {
  registerOAuthProviderFactory(PROVIDER_ID, stubProvider);
  // Instance default, for the inherit path.
  registerOAuthProvider(
    stubProvider({ clientId: "instance-client", clientSecret: "instance-secret" }),
  );
  await startTestServer();
});

afterAll(async () => {
  unregisterOAuthProviderFactory(PROVIDER_ID);
  unregisterOAuthProvider(PROVIDER_ID);
  await stopTestServer();
});

beforeEach(async () => {
  await resetDatabase();
  validatedWithSecret = [];
});

function cookieHeader(response: { headers: Headers }) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function locationOf(response: { headers: Headers }) {
  return new URL(response.headers.get("location") ?? "");
}

async function seedOverride(
  projectId: string,
  clientId: string,
  clientSecret: string,
) {
  return prisma.projectOAuthCredential.create({
    data: {
      project_id: projectId,
      provider_id: PROVIDER_ID,
      client_id: clientId,
      client_secret_enc: encrypt(clientSecret, PROJECT_OAUTH_CONTEXT),
      mode: "OVERRIDE",
    },
  });
}

async function seedDisabled(projectId: string) {
  return prisma.projectOAuthCredential.create({
    data: {
      project_id: projectId,
      provider_id: PROVIDER_ID,
      client_id: "",
      client_secret_enc: null,
      mode: "DISABLED",
    },
  });
}

async function startFlow(projectId: string) {
  const started = await api(
    "GET",
    `/oauth/${PROVIDER_ID}?projectId=${projectId}`,
    { redirect: "manual" },
  );

  return {
    response: started,
    state: locationOf(started).searchParams.get("state") ?? "",
    cookie: cookieHeader(started),
  };
}

async function completeFlow(projectId: string) {
  const { state, cookie } = await startFlow(projectId);

  const callback = await api(
    "GET",
    `/oauth/${PROVIDER_ID}/callback?code=${VALID_CODE}&state=${state}`,
    { redirect: "manual", headers: { cookie } },
  );

  return { code: locationOf(callback).searchParams.get("code") };
}

describe("per-Project OAuth credential isolation", () => {
  it("routes each Project's authorization redirect through its own client id", async () => {
    const a = await createTestProject({ name: "Project A" });
    const b = await createTestProject({ name: "Project B" });
    await seedOverride(a.id, "client-A", "secret-A");
    await seedOverride(b.id, "client-B", "secret-B");

    const startedA = await startFlow(a.id);
    const startedB = await startFlow(b.id);

    // Mutation: dropping the project_id filter in the ProjectOAuthCredential
    // lookup makes one Project's redirect carry the other's client id.
    expect(startedA.response.status).toBe(302);
    expect(locationOf(startedA.response).searchParams.get("client_id")).toBe(
      "client-A",
    );
    expect(locationOf(startedA.response).search).not.toContain("client-B");

    expect(locationOf(startedB.response).searchParams.get("client_id")).toBe(
      "client-B",
    );
    expect(locationOf(startedB.response).search).not.toContain("client-A");
  });

  it("validates the code with the Project's decrypted secret on a full round trip", async () => {
    const a = await createTestProject({ name: "Project A" });
    await seedOverride(a.id, "client-A", "secret-A");

    const { code } = await completeFlow(a.id);
    expect(code).toBeString();

    const exchanged = await api("POST", "/oauth/exchange", { body: { code } });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.accessToken).toBeString();

    const session = await prisma.session.findFirstOrThrow({
      where: { project_id: a.id },
    });
    expect(session.id).toBeString();

    // The provider that validated the code was built from secret-A — decrypted
    // from the row, never the ciphertext or B's value.
    expect(validatedWithSecret).toEqual(["secret-A"]);
  });
});

describe("inherit path", () => {
  it("uses the instance default when the Project has no credential row", async () => {
    const project = await createTestProject();

    const { code } = await completeFlow(project.id);
    expect(code).toBeString();
    expect(validatedWithSecret).toEqual(["instance-secret"]);
  });
});

describe("disabled provider", () => {
  it("404s the authorization start and omits the provider from discovery", async () => {
    const project = await createTestProject();
    await seedDisabled(project.id);

    const started = await api(
      "GET",
      `/oauth/${PROVIDER_ID}?projectId=${project.id}`,
      { redirect: "manual" },
    );
    expect(started.status).toBe(404);
    expect(started.body.error.code).toBe("provider_not_found");

    const discovery = await api(
      "GET",
      `/oauth/providers?projectId=${project.id}`,
    );
    expect(discovery.body.providers).not.toContain(PROVIDER_ID);
  });

  it("fails a forced callback with provider_not_found and leaves linked accounts intact", async () => {
    const project = await createTestProject();

    // A user who linked this provider while it was still enabled.
    const user = await prisma.user.create({
      data: {
        project_id: project.id,
        email: "linked@example.com",
        email_verified: true,
      },
    });
    await prisma.account.create({
      data: {
        user_id: user.id,
        project_id: project.id,
        provider_id: PROVIDER_ID,
        account_id: "stub-account-1",
      },
    });

    // Start while still enabled to get a valid signed state + cookie, then
    // disable before the callback comes back.
    const { state, cookie } = await startFlow(project.id);
    await seedDisabled(project.id);

    const callback = await api(
      "GET",
      `/oauth/${PROVIDER_ID}/callback?code=${VALID_CODE}&state=${state}`,
      { redirect: "manual", headers: { cookie } },
    );

    expect(locationOf(callback).searchParams.get("error")).toBe(
      "provider_not_found",
    );
    expect(
      await prisma.account.count({
        where: { project_id: project.id, provider_id: PROVIDER_ID },
      }),
    ).toBe(1);
  });
});

describe("effective provider list", () => {
  it("adds an OVERRIDE for a provider the instance never configured", async () => {
    const project = await createTestProject();
    await prisma.projectOAuthCredential.create({
      data: {
        project_id: project.id,
        provider_id: "github",
        client_id: "gh-client",
        client_secret_enc: encrypt("gh-secret", PROJECT_OAUTH_CONTEXT),
        mode: "OVERRIDE",
      },
    });

    const response = await api(
      "GET",
      `/oauth/providers?projectId=${project.id}`,
    );

    expect(response.body.providers).toContain("github");
    // The instance default is still listed too.
    expect(response.body.providers).toContain(PROVIDER_ID);
  });
});

describe("secret at rest", () => {
  it("stores the client secret encrypted under the project-oauth context only", async () => {
    const project = await createTestProject();
    await seedOverride(project.id, "client-A", "super-secret-value");

    const row = await prisma.projectOAuthCredential.findFirstOrThrow({
      where: { project_id: project.id },
    });

    expect(row.client_secret_enc).not.toBe("super-secret-value");
    expect(row.client_secret_enc).not.toContain("super-secret-value");
    expect(decrypt(row.client_secret_enc!, PROJECT_OAUTH_CONTEXT)).toBe(
      "super-secret-value",
    );
    // A different derivation context must not open it.
    expect(() => decrypt(row.client_secret_enc!, MFA_CONTEXT)).toThrow();
  });
});

describe("security event enum", () => {
  it("carries PROJECT_OAUTH_CONFIG_CHANGED at WARNING severity", async () => {
    const project = await createTestProject();
    const event = await prisma.securityEvent.create({
      data: {
        event_type: "PROJECT_OAUTH_CONFIG_CHANGED",
        severity: "WARNING",
        project_id: project.id,
        metadata: { provider: PROVIDER_ID, action: "configured" },
      },
    });

    expect(event.event_type).toBe("PROJECT_OAUTH_CONFIG_CHANGED");
  });
});
