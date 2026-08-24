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

  it("stays in lockstep with what both SDKs were built against", async () => {
    // ADR 0003 makes exact match the whole mechanism, so an SDK's baked-in
    // constant drifting from the server's package version would break every
    // integration silently. This repo is where all three live; hold them
    // together.
    for (const sdk of ["backend-sdk", "client-sdk"] as const) {
      const sdkPackage = await Bun.file(
        new URL(`../../packages/${sdk}/package.json`, import.meta.url),
      ).json();
      const { CONTRACT_VERSION } = await import(
        `../../packages/${sdk}/src/version`
      );

      expect(CONTRACT_VERSION).toBe(packageVersion);
      expect(sdkPackage.version).toBe(packageVersion);
    }
  });
});
