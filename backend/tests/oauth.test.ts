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
import {
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthProfile,
} from "../lib/oauth/providers";

const PROVIDER_ID = "stub";
const VALID_CODE = "valid-authorization-code";

let project: Awaited<ReturnType<typeof createTestProject>>;

/**
 * Stands in for a real provider so the whole redirect round trip can be
 * exercised without network access or live credentials.
 */
let profile: OAuthProfile = {
  accountId: "stub-account-1",
  email: "social@example.com",
  emailVerified: true,
  name: "Ada Lovelace",
  image: "https://example.com/avatar.png",
};

beforeAll(async () => {
  registerOAuthProvider({
    id: PROVIDER_ID,
    scopes: ["email"],
    usesPkce: true,
    createAuthorizationURL: (state, codeVerifier) =>
      new URL(
        `https://provider.example/authorize?state=${state}&code_challenge=${codeVerifier}`,
      ),
    async validateAuthorizationCode(code) {
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
  });

  await startTestServer();
});

afterAll(async () => {
  unregisterOAuthProvider(PROVIDER_ID);
  await stopTestServer();
});

beforeEach(async () => {
  await resetDatabase();
  profile = {
    accountId: "stub-account-1",
    email: "social@example.com",
    emailVerified: true,
    name: "Ada Lovelace",
    image: "https://example.com/avatar.png",
  };
  project = await createTestProject();
});

function cookieHeader(response: { headers: Headers }) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function stateFrom(response: { headers: Headers }) {
  const location = response.headers.get("location") ?? "";

  return new URL(location).searchParams.get("state") ?? "";
}

async function startFlow() {
  const started = await api(
    "GET",
    `/oauth/${PROVIDER_ID}?projectId=${project.id}`,
    { redirect: "manual" },
  );

  return { state: stateFrom(started), cookie: cookieHeader(started) };
}

async function completeFlow(overrides: { state?: string; code?: string } = {}) {
  const { state, cookie } = await startFlow();

  const callback = await api(
    "GET",
    `/oauth/${PROVIDER_ID}/callback?code=${overrides.code ?? VALID_CODE}&state=${overrides.state ?? state}`,
    { redirect: "manual", headers: { cookie } },
  );

  const location = new URL(callback.headers.get("location") ?? "");

  return {
    code: location.searchParams.get("code"),
    error: location.searchParams.get("error"),
  };
}

describe("provider discovery", () => {
  it("lists the enabled providers", async () => {
    const response = await api("GET", "/oauth/providers");

    expect(response.status).toBe(200);
    expect(response.body.providers).toContain(PROVIDER_ID);
  });

  it("404s an unknown provider", async () => {
    const response = await api("GET", "/oauth/nosuchprovider", {
      redirect: "manual",
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("provider_not_found");
  });
});

describe("authorization redirect", () => {
  it("redirects to the provider and remembers the state", async () => {
    const response = await api(
      "GET",
      `/oauth/${PROVIDER_ID}?projectId=${project.id}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("provider.example");
    expect(cookieHeader(response)).toContain("kauth_oauth_state=");
  });
});

describe("callback", () => {
  it("rejects a state that does not match the cookie", async () => {
    const result = await completeFlow({ state: "attacker-supplied-state" });

    expect(result.error).toBe("state_mismatch");
    expect(result.code).toBeNull();
  });

  it("rejects a callback with no state cookie at all", async () => {
    const response = await api(
      "GET",
      `/oauth/${PROVIDER_ID}/callback?code=${VALID_CODE}&state=whatever`,
      { redirect: "manual" },
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("state_mismatch");
  });

  it("reports a provider-side error back to the frontend", async () => {
    const { cookie, state } = await startFlow();

    const response = await api(
      "GET",
      `/oauth/${PROVIDER_ID}/callback?error=access_denied&state=${state}`,
      { redirect: "manual", headers: { cookie } },
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  it("logs a failed flow", async () => {
    await completeFlow({ state: "attacker-supplied-state" });

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "OAUTH_LOGIN_FAILED" },
    });

    expect(event.metadata).toMatchObject({ reason: "state_mismatch" });
  });

  it("creates a user and hands back an exchange code", async () => {
    const result = await completeFlow();

    expect(result.error).toBeNull();
    expect(result.code).toBeString();

    const user = await prisma.user.findUniqueOrThrow({
      where: {
        project_id_email: { project_id: project.id, email: "social@example.com" },
      },
      include: { accounts: true },
    });

    expect(user.email_verified).toBe(true);
    expect(user.first_name).toBe("Ada");
    expect(user.last_name).toBe("Lovelace");
    expect(user.username).toBeNull();
    expect(user.accounts[0]!.provider_id).toBe(PROVIDER_ID);
    expect(user.accounts[0]!.password).toBeNull();
  });

  it("reuses the same user on a second sign-in", async () => {
    await completeFlow();
    await completeFlow();

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.account.count()).toBe(1);
  });
});

describe("account linking", () => {
  const credentials = {
    email: "social@example.com",
    username: "existing",
    password: "correct-horse-battery",
  };

  it("links to an existing account when the provider verified the email", async () => {
    await api("POST", "/register", { body: credentials, projectId: project.id });

    const result = await completeFlow();
    expect(result.code).toBeString();

    expect(await prisma.user.count()).toBe(1);

    const user = await prisma.user.findUniqueOrThrow({
      where: {
        project_id_email: { project_id: project.id, email: credentials.email },
      },
      include: { accounts: true },
    });

    expect(user.accounts.map((account) => account.provider_id).sort()).toEqual([
      "credential",
      PROVIDER_ID,
    ]);

    const linked = await prisma.securityEvent.findFirst({
      where: { event_type: "OAUTH_ACCOUNT_LINKED" },
    });
    expect(linked).not.toBeNull();
  });

  it("refuses to link when the provider has not verified the email", async () => {
    await api("POST", "/register", { body: credentials, projectId: project.id });
    profile = { ...profile, emailVerified: false };

    const result = await completeFlow();

    expect(result.error).toBe("oauth_email_unverified");
    expect(await prisma.account.count()).toBe(1);
  });

  it("refuses a provider that supplies no email", async () => {
    profile = { ...profile, email: null };

    const result = await completeFlow();

    expect(result.error).toBe("oauth_no_email");
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("code exchange", () => {
  it("trades the code for a usable token pair", async () => {
    const { code } = await completeFlow();

    const exchanged = await api("POST", "/oauth/exchange", { body: { code } });

    expect(exchanged.status).toBe(200);
    expect(exchanged.body.accessToken).toBeString();

    const protectedResponse = await api("GET", "/protected", {
      accessToken: exchanged.body.accessToken,
    });
    expect(protectedResponse.status).toBe(200);

    const refreshed = await api("POST", "/refresh", {
      body: { refreshToken: exchanged.body.refreshToken },
    });
    expect(refreshed.status).toBe(200);
  });

  it("is single use", async () => {
    const { code } = await completeFlow();

    await api("POST", "/oauth/exchange", { body: { code } });
    const replay = await api("POST", "/oauth/exchange", { body: { code } });

    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("token_invalid");
  });

  it("rejects a code that was never issued", async () => {
    const response = await api("POST", "/oauth/exchange", {
      body: { code: "not-a-real-exchange-code" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("token_invalid");
  });

  it("requires a device id", async () => {
    const { code } = await completeFlow();

    const response = await api("POST", "/oauth/exchange", {
      body: { code },
      deviceId: null,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("device_id_missing");
  });
});
