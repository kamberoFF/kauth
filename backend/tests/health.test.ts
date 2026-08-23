import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { api, startTestServer, stopTestServer } from "./helpers/api";
import { prisma } from "../lib/prisma";

beforeAll(startTestServer);
afterAll(stopTestServer);

describe("liveness", () => {
  it("stays a static ok response", async () => {
    const response = await api("GET", "/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("readiness", () => {
  it("returns ok when the database is reachable", async () => {
    const response = await api("GET", "/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("returns 503 with the shared error shape when the database is not", async () => {
    const original = prisma.$queryRaw;
    // @ts-expect-error - deliberately swapped out for this one assertion
    prisma.$queryRaw = () => Promise.reject(new Error("connection refused"));

    try {
      const response = await api("GET", "/health/ready");

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: { message: "Database unavailable", code: "database_unavailable" },
      });
    } finally {
      prisma.$queryRaw = original;
    }
  });
});
