import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { api, startTestServer, stopTestServer } from "./helpers/api";
import { CONTRACT_VERSION_HEADER } from "../constants/headers";
import { version as packageVersion } from "../package.json";

beforeAll(startTestServer);
afterAll(stopTestServer);

/**
 * ADR 0003: kauth's own package release version *is* the contract version —
 * no parallel numbering scheme. The SDKs compare it exactly on every request.
 */
describe("X-Kauth-Contract-Version", () => {
  it("is emitted on a successful response", async () => {
    const response = await api("GET", "/health");

    expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(packageVersion);
  });

  it("is emitted on an error response too", async () => {
    const response = await api("GET", "/this-route-does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(packageVersion);
  });
});
