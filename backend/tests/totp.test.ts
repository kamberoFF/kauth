import { describe, expect, it } from "bun:test";
import { decodeBase32 } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  buildOtpauthUri,
  generateTotpSecret,
  matchTotpStep,
} from "../lib/totp";

const RFC_6238_VECTORS = [
  { time: 59, code: "94287082" },
  { time: 1111111109, code: "07081804" },
  { time: 1234567890, code: "89005924" },
] as const;

/** The RFC 6238 test key ("12345678901234567890"), base32-encoded. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function stepToDate(stepSeconds: number) {
  return new Date(stepSeconds * 1000);
}

describe("totp helpers", () => {
  it("generates a 20-byte secret that decodes as valid base32", () => {
    const secret = generateTotpSecret();

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(decodeBase32(secret)).toHaveLength(20);
  });

  it("generates distinct secrets across calls", () => {
    const secrets = new Set(Array.from({ length: 25 }, () => generateTotpSecret()));

    expect(secrets.size).toBe(25);
  });

  it("builds an otpauth URI whose parameters parse back to the inputs", () => {
    const uri = new URL(buildOtpauthUri("user@example.com", RFC_SECRET));

    expect(uri.protocol).toBe("otpauth:");
    expect(uri.hostname).toBe("totp");
    // Label is issuer-qualified per the otpauth convention. (The URL parser
    // reads "totp" as the host, leaving the label alone in the path.)
    expect(decodeURIComponent(uri.pathname)).toBe("/kauth:user@example.com");

    expect(uri.searchParams.get("issuer")).toBe("kauth");
    expect(uri.searchParams.get("algorithm")).toBe("SHA1");
    expect(uri.searchParams.get("digits")).toBe(String(TOTP_DIGITS));
    expect(uri.searchParams.get("period")).toBe(String(TOTP_PERIOD_SECONDS));

    const embeddedSecret = uri.searchParams.get("secret");
    expect(embeddedSecret).not.toBeNull();
    expect(Buffer.from(decodeBase32(embeddedSecret!))).toEqual(
      Buffer.from(decodeBase32(RFC_SECRET)),
    );
  });

  it("matches codes generated at the current step (RFC 6238 vectors)", () => {
    for (const { time, code } of RFC_6238_VECTORS) {
      // The RFC vectors are printed 8-digit; HOTP truncation keeps the last N.
      const matched = matchTotpStep(RFC_SECRET, code.slice(-TOTP_DIGITS), stepToDate(time));

      expect(matched).not.toBeNull();
      expect(matched).toBe(Math.floor(time / TOTP_PERIOD_SECONDS));
    }
  });

  // Mutation check (named, per repo convention): widen the window to ±2
  // steps and the stale-code rejection below goes red; narrow the replay
  // contract in ticket 03 (codes at or below last_totp_step) and the
  // matched-step value this returns is what catches it.
  it("accepts a code from the adjacent earlier step but not an older one", () => {
    const nowStep = Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000));
    const key = decodeBase32(RFC_SECRET);

    const previousCode = generateHOTP(key, BigInt(nowStep - 1), TOTP_DIGITS);
    const staleCode = generateHOTP(key, BigInt(nowStep - 2), TOTP_DIGITS);

    expect(matchTotpStep(RFC_SECRET, previousCode)).toBe(nowStep - 1);
    expect(matchTotpStep(RFC_SECRET, staleCode)).toBeNull();
  });

  it("rejects garbage and wrong-length codes", () => {
    expect(matchTotpStep(RFC_SECRET, "not-a-code")).toBeNull();
    expect(matchTotpStep(RFC_SECRET, "12345")).toBeNull();
    expect(matchTotpStep(RFC_SECRET, "")).toBeNull();
  });

  it("rejects a code belonging to a different secret", () => {
    const otherKey = decodeBase32(generateTotpSecret());
    const foreignCode = generateHOTP(otherKey, BigInt(Math.floor(Date.now() / 30_000)), TOTP_DIGITS);

    expect(matchTotpStep(RFC_SECRET, foreignCode)).toBeNull();
  });
});
