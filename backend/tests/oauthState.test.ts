import { describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import { signState, verifyState } from "../lib/oauthState";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("oauthState", () => {
  it("round-trips a signed state", () => {
    const verified = verifyState(signState(PROJECT_ID));

    expect(verified).not.toBeNull();
    expect(verified!.projectId).toBe(PROJECT_ID);
    expect(verified!.random).toBeString();
  });

  it("uses a fresh random component every call", () => {
    expect(signState(PROJECT_ID)).not.toBe(signState(PROJECT_ID));
  });

  it("rejects a state whose HMAC is garbage", () => {
    const [random, projectId] = signState(PROJECT_ID).split(".");

    expect(verifyState(`${random}.${projectId}.deadbeef`)).toBeNull();
  });

  it("rejects a state whose projectId was swapped after signing", () => {
    const [random, , mac] = signState(PROJECT_ID).split(".");

    expect(verifyState(`${random}.${OTHER_PROJECT_ID}.${mac}`)).toBeNull();
  });

  it("rejects a signature made with a different key", () => {
    const payload = `abc.${PROJECT_ID}`;
    const wrongMac = crypto
      .createHmac("sha256", "not-the-derivation-key")
      .update(payload)
      .digest("hex");

    expect(verifyState(`${payload}.${wrongMac}`)).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(verifyState("")).toBeNull();
    expect(verifyState("only.two")).toBeNull();
    expect(verifyState("a.b.c.d")).toBeNull();
    expect(verifyState("a.b.nothex")).toBeNull();
    expect(verifyState("..")).toBeNull();
  });
});
