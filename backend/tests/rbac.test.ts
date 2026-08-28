import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import jwt from "jsonwebtoken";
import {
  api,
  registerAndSignIn,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { ensurePlatformProject } from "../lib/platformProject";
import { PLATFORM_PROJECT_ID } from "../constants/platform";
import config from "../config";

function decodeClaims(token: string) {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

const credentials = {
  email: "staff@example.com",
  username: "staff",
  password: "correct-horse-battery",
};

let platformUser: { id: string };

/** Registers the suite's main user into the reserved platform Project. */
async function signInToPlatformProject(
  overrides: Partial<typeof credentials> = {},
) {
  // Register→login (ADR 0008): register no longer signs the user in.
  const signedIn = await registerAndSignIn(
    { ...credentials, ...overrides },
    PLATFORM_PROJECT_ID,
  );

  expect(signedIn.status).toBe(200);

  return {
    accessToken: signedIn.body.accessToken as string,
    refreshToken: signedIn.body.refreshToken as string,
    userId: signedIn.body.user.id as string,
  };
}

async function promote(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { role: "ADMIN" },
  });
}

beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetDatabase();
  await ensurePlatformProject();

  // The suite's main actor, promoted to staff by the tests that need one.
  const registered = await signInToPlatformProject();
  platformUser = { id: registered.userId };
});

describe("the role claim rides every minted access token", () => {
  it("registration mints role USER", async () => {
    const { accessToken } = await signInToPlatformProject({
      email: "fresh@example.com",
      username: "fresh",
    });

    expect(decodeClaims(accessToken).role).toBe("USER");
  });

  it("login mints the role the row currently holds", async () => {
    await promote(platformUser.id);

    const login = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: null,
      projectId: PLATFORM_PROJECT_ID,
    });

    // The device cookie was dropped between suites, so phase two would
    // trigger only if enrolled — this account is not, and login answers
    // with tokens directly.
    expect(login.status).toBe(200);
    expect(decodeClaims(login.body.accessToken).role).toBe("ADMIN");
  });

  it("refresh rotation re-mints the claim from the database", async () => {
    await promote(platformUser.id);

    const signedIn = await signInToPlatformProject({
      email: "rotator@example.com",
      username: "rotator",
    });
    expect(decodeClaims(signedIn.accessToken).role).toBe("USER");

    await promote(signedIn.userId);

    const refreshed = await api("POST", "/refresh", {
      body: { refreshToken: signedIn.refreshToken },
    });

    expect(refreshed.status).toBe(200);
    expect(decodeClaims(refreshed.body.accessToken).role).toBe("ADMIN");
  });
});

describe("requirePlatformStaff authorizes from the database, not the claim", () => {
  it("serves a promoted platform admin on a token minted before promotion", async () => {
    const signedIn = await signInToPlatformProject({
      email: "before-promotion@example.com",
      username: "before-promotion",
    });
    await promote(signedIn.userId);

    const response = await api("GET", "/admin/projects", {
      accessToken: signedIn.accessToken,
    });

    expect(response.status).toBe(200);
  });

  it("demotes instantly despite the stale ADMIN claim", async () => {
    await promote(platformUser.id);

    const login = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: null,
      projectId: PLATFORM_PROJECT_ID,
    });
    const staleAdminToken = login.body.accessToken as string;
    expect(decodeClaims(staleAdminToken).role).toBe("ADMIN");

    await prisma.user.update({
      where: { id: platformUser.id },
      data: { role: "USER" },
    });

    // The claim still says ADMIN — and must be ignored anyway.
    expect(decodeClaims(staleAdminToken).role).toBe("ADMIN");

    const response = await api("GET", "/admin/projects", {
      accessToken: staleAdminToken,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("staff_forbidden");
  });

  it("refuses a plain USER inside the platform Project", async () => {
    const response = await api("GET", "/admin/projects", {
      accessToken: (
        await signInToPlatformProject({
          email: "plain@example.com",
          username: "plain",
        })
      ).accessToken,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("staff_forbidden");
  });

  it("refuses an ADMIN whose Project is not the platform Project", async () => {
    const otherProject = await createTestProject({ name: "Other Tenant" });
    const tenantAdmin = await registerAndSignIn(
      {
        email: "tenant-admin@example.com",
        username: "tenant-admin",
        password: credentials.password,
      },
      otherProject.id,
    );

    await prisma.user.update({
      where: { id: tenantAdmin.body.user.id },
      data: { role: "ADMIN" },
    });

    const response = await api("GET", "/admin/projects", {
      accessToken: tenantAdmin.body.accessToken,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("staff_forbidden");
  });

  it("answers 401 before any role question when no token is presented", async () => {
    const response = await api("GET", "/admin/projects");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_missing");
  });

  it("answers 401 when the session behind the token is revoked", async () => {
    await promote(platformUser.id);

    const login = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      deviceId: null,
      projectId: PLATFORM_PROJECT_ID,
    });
    const accessToken = login.body.accessToken as string;

    await prisma.session.updateMany({
      where: { status: "ACTIVE" },
      data: { status: "REVOKED", revoked_at: new Date() },
    });

    const response = await api("GET", "/admin/projects", { accessToken });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("session_revoked");
  });

  it("rejects a correctly-signed token with no role claim", async () => {
    // Forged against a plain USER's session: if the missing claim were
    // overlooked, the DB would still say USER and the request would die as
    // 403 staff_forbidden instead of refusing the malformed token outright.
    const plain = await signInToPlatformProject({
      email: "forged-against@example.com",
      username: "forged-against",
    });

    const forged = jwt.sign(
      {
        userId: plain.userId,
        familyId: crypto.randomUUID(),
        sid: (
          await prisma.session.findFirstOrThrow({
            where: { user_id: plain.userId, status: "ACTIVE" },
          })
        ).id,
        projectId: PLATFORM_PROJECT_ID,
      },
      config.jwt_secret,
      { algorithm: "HS256", expiresIn: 60, jwtid: crypto.randomUUID() },
    );

    const response = await api("GET", "/admin/projects", {
      accessToken: forged,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("token_invalid");
  });
});

describe("the staff project listing", () => {
  it("lists every project across tenants, platform one included", async () => {
    await promote(platformUser.id);

    const tenantA = await createTestProject({ name: "Tenant A" });
    const tenantB = await createTestProject({ name: "Tenant B" });

    const response = await api("GET", "/admin/projects", {
      accessToken: (
        await api("POST", "/login", {
          body: { email: credentials.email, password: credentials.password },
          deviceId: null,
          projectId: PLATFORM_PROJECT_ID,
        })
      ).body.accessToken,
    });

    expect(response.status).toBe(200);

    const names = response.body.projects.map((p: any) => p.name).sort();
    expect(names).toEqual(["Tenant A", "Tenant B", "kauth Platform"]);

    const listed = response.body.projects.find(
      (p: any) => p.name === "Tenant A",
    );
    expect(listed.id).toBe(tenantA.id);
    expect(listed.ownerId).toBeNull();
    expect(typeof listed.createdAt).toBe("string");
    expect(tenantB.id).not.toBe(tenantA.id);
  });
});
