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

const credentials = {
  email: "developer@example.com",
  username: "developer",
  password: "correct-horse-battery",
};

function registerDeveloper() {
  return api("POST", "/register", {
    body: credentials,
    projectId: PLATFORM_PROJECT_ID,
  });
}

beforeAll(startTestServer);
afterAll(stopTestServer);

beforeEach(async () => {
  await resetDatabase();
  await ensurePlatformProject();
});

describe("reserved platform project", () => {
  it("exists after ensurePlatformProject, identifiable by its fixed id", async () => {
    const first = await ensurePlatformProject();
    const second = await ensurePlatformProject();

    expect(first.id).toBe(PLATFORM_PROJECT_ID);
    expect(second.id).toBe(PLATFORM_PROJECT_ID);

    const rows = await prisma.project.findMany({
      where: { id: PLATFORM_PROJECT_ID },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("developer register/login through the reserved project", () => {
  it("registers a developer into the platform project", async () => {
    const response = await registerDeveloper();
    expect(response.status).toBe(201);

    const user = await prisma.user.findUniqueOrThrow({
      where: {
        project_id_email: {
          project_id: PLATFORM_PROJECT_ID,
          email: credentials.email,
        },
      },
    });
    expect(user.project_id).toBe(PLATFORM_PROJECT_ID);
    expect(user.role).toBe("USER");
  });

  it("logs the developer back in through the same endpoint", async () => {
    await registerDeveloper();

    const response = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: PLATFORM_PROJECT_ID,
    });

    expect(response.status).toBe(200);
  });
});

describe("role distinguishes developer from platform staff", () => {
  it("lets both an ordinary developer and platform staff register/log in identically", async () => {
    await registerDeveloper();

    const staff = {
      email: "staff@example.com",
      username: "staff",
      password: "correct-horse-battery",
    };
    await api("POST", "/register", {
      body: staff,
      projectId: PLATFORM_PROJECT_ID,
    });
    await prisma.user.update({
      where: {
        project_id_email: {
          project_id: PLATFORM_PROJECT_ID,
          email: staff.email,
        },
      },
      data: { role: "ADMIN" },
    });

    const developerLogin = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: PLATFORM_PROJECT_ID,
    });
    const staffLogin = await api("POST", "/login", {
      body: { email: staff.email, password: staff.password },
      projectId: PLATFORM_PROJECT_ID,
    });

    expect(developerLogin.status).toBe(200);
    expect(staffLogin.status).toBe(200);

    const staffUser = await prisma.user.findUniqueOrThrow({
      where: {
        project_id_email: {
          project_id: PLATFORM_PROJECT_ID,
          email: staff.email,
        },
      },
    });
    expect(staffUser.role).toBe("ADMIN");
  });
});

describe("POST /projects", () => {
  it("creates a project owned by the authenticated platform developer", async () => {
    const registered = await registerDeveloper();
    const accessToken = registered.body.accessToken;

    const response = await api("POST", "/projects", {
      body: { name: "My New Product" },
      accessToken,
    });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe("My New Product");
    expect(response.body.ownerId).toBe(registered.body.user.id);

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: response.body.id },
      include: { owner: true },
    });
    expect(project.owner_id).toBe(registered.body.user.id);
    expect(project.owner?.project_id).toBe(PLATFORM_PROJECT_ID);
  });

  it("rejects creation from a user of an ordinary, non-platform project", async () => {
    const ordinaryProject = await createTestProject();
    const endUser = {
      email: "enduser@example.com",
      username: "enduser",
      password: "correct-horse-battery",
    };

    const registered = await api("POST", "/register", {
      body: endUser,
      projectId: ordinaryProject.id,
    });

    const response = await api("POST", "/projects", {
      body: { name: "Should Not Exist" },
      accessToken: registered.body.accessToken,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("not_platform_developer");

    const projects = await prisma.project.findMany({
      where: { name: "Should Not Exist" },
    });
    expect(projects).toHaveLength(0);
  });

  it("rejects an unauthenticated request", async () => {
    const response = await api("POST", "/projects", {
      body: { name: "No Auth" },
    });

    expect(response.status).toBe(401);
  });
});

describe("end-to-end bootstrap flow", () => {
  it("registers a developer, logs in, and creates a project they own", async () => {
    const registered = await registerDeveloper();
    expect(registered.status).toBe(201);

    const loggedIn = await api("POST", "/login", {
      body: { email: credentials.email, password: credentials.password },
      projectId: PLATFORM_PROJECT_ID,
    });
    expect(loggedIn.status).toBe(200);

    const created = await api("POST", "/projects", {
      body: { name: "Bootstrap Product" },
      accessToken: loggedIn.body.accessToken,
    });
    expect(created.status).toBe(201);

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(project.owner_id).toBe(registered.body.user.id);
    expect(project.name).toBe("Bootstrap Product");
  });
});
