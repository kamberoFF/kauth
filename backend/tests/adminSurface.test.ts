import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  createTestProject,
  resetDatabase,
  startTestServer,
  stopTestServer,
} from "./helpers/api";
import { prisma } from "../lib/prisma";
import { ensurePlatformProject } from "../lib/platformProject";
import { PLATFORM_PROJECT_ID } from "../constants/platform";

const USER_PASSWORD = "correct-horse-battery";

let tenantProject: Awaited<ReturnType<typeof createTestProject>>;

interface SignIn {
  accessToken: string;
  userId: string;
}

function registerBody(suffix: string) {
  return {
    email: `${suffix}@example.com`,
    username: suffix,
    password: USER_PASSWORD,
  };
}

/** Registers into the platform Project and promotes; fresh login each call. */
async function makeStaff(suffix = "staff-surface"): Promise<SignIn> {
  const registered = await api("POST", "/register", {
    body: registerBody(suffix),
    projectId: PLATFORM_PROJECT_ID,
  });
  expect(registered.status).toBe(201);

  await prisma.user.update({
    where: { id: registered.body.user.id },
    data: { role: "ADMIN" },
  });

  return {
    accessToken: registered.body.accessToken as string,
    userId: registered.body.user.id as string,
  };
}

async function makePlatformUser(suffix: string): Promise<SignIn> {
  const registered = await api("POST", "/register", {
    body: registerBody(suffix),
    projectId: PLATFORM_PROJECT_ID,
  });
  expect(registered.status).toBe(201);

  return {
    accessToken: registered.body.accessToken as string,
    userId: registered.body.user.id as string,
  };
}

async function makeTenantUser(suffix: string, projectId?: string) {
  const registered = await api("POST", "/register", {
    body: registerBody(suffix),
    projectId: projectId ?? tenantProject.id,
  });
  expect(registered.status).toBe(201);

  return {
    accessToken: registered.body.accessToken as string,
    userId: registered.body.user.id as string,
  };
}

function staffGet(path: string, staff: SignIn) {
  return api("GET", path, { accessToken: staff.accessToken });
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
  tenantProject = await createTestProject({ name: "Surface Tenant" });
});

describe("GET /admin/projects/:projectId/users", () => {
  it("lists another tenant's users for staff", async () => {
    const staff = await makeStaff("surface-staff");
    await makeTenantUser("tenant-user-a");
    await makeTenantUser("tenant-user-b");

    const response = await staffGet(
      `/admin/projects/${tenantProject.id}/users`,
      staff,
    );

    expect(response.status).toBe(200);
    expect(response.body.users).toHaveLength(2);
    expect(response.body.users[0].email).toBe("tenant-user-a@example.com");
    expect(response.body.users[0]).toHaveProperty("role");
  });

  it("404s an unknown project with the shared code", async () => {
    const staff = await makeStaff("surface-staff-404");

    const response = await staffGet(
      "/admin/projects/11111111-2222-4333-8444-555555555555/users",
      staff,
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("project_not_found");
  });
});

describe("staff cross-project session operations", () => {
  async function victimSession(suffix: string) {
    const victim = await makeTenantUser(suffix);
    const session = await prisma.session.findFirstOrThrow({
      where: { user_id: victim.userId, status: "ACTIVE" },
    });
    return { victim, sessionId: session.id };
  }

  it("lets staff view any session", async () => {
    const staff = await makeStaff();
    const { victim, sessionId } = await victimSession("viewed-victim");

    const response = await staffGet(`/admin/sessions/${sessionId}`, staff);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(sessionId);
    expect(response.body.userId).toBe(victim.userId);
    expect(response.body.status).toBe("ACTIVE");
  });

  it("lets staff revoke any session, audited with actor attribution", async () => {
    const staff = await makeStaff();
    const { victim, sessionId } = await victimSession("revoked-victim");

    const response = await api("DELETE", `/admin/sessions/${sessionId}`, {
      accessToken: staff.accessToken,
    });

    expect(response.status).toBe(200);

    const session = await prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(session.status).toBe("REVOKED");
    expect(session.revoked_reason).toBe("staff_revoked");

    // The victim's next request dies even though their token is untouched.
    const afterRevocation = await api("GET", "/protected", {
      accessToken: victim.accessToken,
    });
    expect(afterRevocation.status).toBe(401);

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "SESSION_REVOKED", session_id: sessionId },
    });
    expect(event.metadata).toMatchObject({ actor_user_id: staff.userId });
  });

  it("404s revoking an already-revoked session", async () => {
    const staff = await makeStaff();
    const { sessionId } = await victimSession("twice-revoked");

    await prisma.session.update({
      where: { id: sessionId },
      data: { status: "REVOKED", revoked_at: new Date() },
    });

    const response = await api("DELETE", `/admin/sessions/${sessionId}`, {
      accessToken: staff.accessToken,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("session_not_found");
  });

  it("404s an unknown session id for both verbs", async () => {
    const staff = await makeStaff();

    const viewed = await staffGet(
      "/admin/sessions/11111111-2222-4333-8444-555555555555",
      staff,
    );
    const revoked = await api(
      "DELETE",
      "/admin/sessions/11111111-2222-4333-8444-555555555555",
      { accessToken: staff.accessToken },
    );

    expect(viewed.status).toBe(404);
    expect(revoked.status).toBe(404);
    expect(viewed.body.error.code).toBe("session_not_found");
  });
});

describe("POST /admin/users/:userId/role", () => {
  it("promotes a platform user, effective on their existing session", async () => {
    const staff = await makeStaff();
    const user = await makePlatformUser("promoted");

    const response = await api("POST", `/admin/users/${user.userId}/role`, {
      accessToken: staff.accessToken,
      body: { role: "ADMIN" },
    });
    expect(response.status).toBe(200);

    // No re-login: the very same access token now clears the staff gate.
    const gated = await api("GET", "/admin/projects", {
      accessToken: user.accessToken,
    });
    expect(gated.status).toBe(200);
  });

  it("demotes a platform admin back to USER", async () => {
    const staff = await makeStaff();
    const user = await makePlatformUser("demoted");
    await prisma.user.update({
      where: { id: user.userId },
      data: { role: "ADMIN" },
    });

    const response = await api("POST", `/admin/users/${user.userId}/role`, {
      accessToken: staff.accessToken,
      body: { role: "USER" },
    });
    expect(response.status).toBe(200);

    const gated = await api("GET", "/admin/projects", {
      accessToken: user.accessToken,
    });
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("staff_forbidden");
  });

  it("records ROLE_CHANGED with old and new roles in metadata", async () => {
    const staff = await makeStaff();
    const user = await makePlatformUser("audited-role");

    await api("POST", `/admin/users/${user.userId}/role`, {
      accessToken: staff.accessToken,
      body: { role: "ADMIN" },
    });

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { event_type: "ROLE_CHANGED" },
      orderBy: { created_at: "desc" },
    });
    expect(event.severity).toBe("WARNING");
    expect(event.user_id).toBe(user.userId);
    expect(event.metadata).toMatchObject({
      old_role: "USER",
      new_role: "ADMIN",
      actor_user_id: staff.userId,
    });
  });

  it("refuses a staff member changing their own role", async () => {
    const staff = await makeStaff();

    const response = await api("POST", `/admin/users/${staff.userId}/role`, {
      accessToken: staff.accessToken,
      body: { role: "USER" },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("self_role_change");

    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: staff.userId },
    });
    expect(unchanged.role).toBe("ADMIN");
  });

  it("404s a target outside the platform Project", async () => {
    const staff = await makeStaff();
    const tenantUser = await makeTenantUser("tenant-target");

    const response = await api("POST", `/admin/users/${tenantUser.userId}/role`, {
      accessToken: staff.accessToken,
      body: { role: "ADMIN" },
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("user_not_found");
  });

  it("400s an invalid role value", async () => {
    const staff = await makeStaff();
    const user = await makePlatformUser("bad-role");

    const response = await api("POST", `/admin/users/${user.userId}/role`, {
      accessToken: staff.accessToken,
      body: { role: "SUPERUSER" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation");
  });
});

describe("scripts/promote-staff.ts", () => {
  async function runScript(args: string[]) {
    const proc = Bun.spawn(["bun", "scripts/promoteStaff.ts", ...args], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { exitCode, stdout };
  }

  it("promotes an existing platform user and is idempotent", async () => {
    const user = await makePlatformUser("script-promoted");

    const first = await runScript(["--email", "script-promoted@example.com"]);
    expect(first.exitCode).toBe(0);

    const role = (
      await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })
    ).role;
    expect(role).toBe("ADMIN");

    const again = await runScript(["--email", "script-promoted@example.com"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already platform staff");
  });

  it("exits non-zero for an unknown email", async () => {
    const result = await runScript(["--email", "nobody@example.com"]);

    expect(result.exitCode).not.toBe(0);
  });

  it("exits non-zero without --email", async () => {
    const result = await runScript([]);

    expect(result.exitCode).not.toBe(0);
  });
});

describe("the whole /admin surface refuses non-staff credentials", () => {
  const PATHS: Array<[string, string]> = [
    ["GET", "/admin/projects"],
    [
      "GET",
      "/admin/projects/11111111-2222-4333-8444-555555555555/users",
    ],
    ["GET", "/admin/sessions/11111111-2222-4333-8444-555555555555"],
    ["DELETE", "/admin/sessions/11111111-2222-4333-8444-555555555555"],
    ["POST", "/admin/users/11111111-2222-4333-8444-555555555555/role"],
  ];

  it.each(PATHS)(
    "answers 401 to a bare API key on %s %s — keys never reach the staff surface",
    async (method, path) => {
      // No bearer token, no cookie: an API key authenticates as a Project,
      // and requireAuth rejects the request before any key logic runs.
      const response = await api(method, path, {
        headers: { "x-api-key": "sk_whatever_secret_key" },
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("token_missing");
    },
  );

  it.each(PATHS)(
    "answers 403 staff_forbidden to a plain platform USER on %s %s",
    async (method, path) => {
      const user = await makePlatformUser("plain-surface");

      const response = await api(method, path, {
        accessToken: user.accessToken,
        body: method === "POST" ? { role: "ADMIN" } : undefined,
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("staff_forbidden");
    },
  );
});
