import { describe, expect, it } from "bun:test";
import { decrypt, encrypt } from "../lib/cryptoBox";

// Every consumer names its own key-derivation context; the MFA TOTP secret
// is the first one and this suite exercises the boundary between contexts.
const MFA_CONTEXT = "kauth:mfa-totp";
const OTHER_CONTEXT = "kauth:project-oauth";

describe("cryptoBox", () => {
  it("round-trips arbitrary payloads", () => {
    const payloads = [
      "hello world",
      "",
      "unicode: 🔐 ünïcodé",
      JSON.stringify({ some: ["structured", "data"], n: 42 }),
      "a".repeat(10_000),
    ];

    for (const plaintext of payloads) {
      expect(decrypt(encrypt(plaintext, MFA_CONTEXT), MFA_CONTEXT)).toBe(plaintext);
    }
  });

  it("produces different ciphertexts for the same input (random IV)", () => {
    const first = encrypt("same input", MFA_CONTEXT);
    const second = encrypt("same input", MFA_CONTEXT);

    expect(first).not.toBe(second);
    // Both must still decrypt to the original.
    expect(decrypt(first, MFA_CONTEXT)).toBe("same input");
    expect(decrypt(second, MFA_CONTEXT)).toBe("same input");
  });

  // A TOTP secret sealed by the pre-context implementation (which hard-coded
  // "kauth:mfa-totp") must still decrypt — the derived key is byte-identical
  // when the context argument equals that old constant. Frozen ciphertext of
  // "JBSWY3DPEHPK3PXP" under ENCRYPTION_KEY = "aa".repeat(32) (tests/setup.ts).
  it("decrypts a secret sealed before the context parameter existed", () => {
    const legacy = "CffXbQ7H7L6vR/PAYS1JMw8R3/XsWO5UhDcYx6PDE0X7qMfd1YWW0D1xi8w=";

    expect(decrypt(legacy, MFA_CONTEXT)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("refuses to decrypt a ciphertext under a different context than it was sealed with", () => {
    const sealed = encrypt("cross-context secret", MFA_CONTEXT);

    expect(() => decrypt(sealed, OTHER_CONTEXT)).toThrow();
    // ...and still opens under its own context.
    expect(decrypt(sealed, MFA_CONTEXT)).toBe("cross-context secret");
  });

  // Mutation check (named, per repo convention): make decrypt swallow
  // decipher.final()'s auth failure and return the raw ciphertext instead —
  // both tamper tests below go red. Restoring the throw turns them green.

  it("throws when a ciphertext bit is flipped (auth tag mismatch)", () => {
    const payload = Buffer.from(encrypt("tamper me", MFA_CONTEXT), "base64");

    // Flip one bit in the middle of the ciphertext body.
    const last = payload.length - 1;
    payload.writeUInt8(payload.readUInt8(last) ^ 0x01, last);

    expect(() => decrypt(payload.toString("base64"), MFA_CONTEXT)).toThrow();
  });

  it("throws when the tag itself is tampered with", () => {
    const payload = Buffer.from(encrypt("tamper me", MFA_CONTEXT), "base64");

    // iv(12) ‖ tag(16) ‖ ciphertext — flip a bit inside the tag.
    payload.writeUInt8(payload.readUInt8(13) ^ 0x80, 13);

    expect(() => decrypt(payload.toString("base64"), MFA_CONTEXT)).toThrow();
  });

  it("throws when truncated or malformed payloads are presented", () => {
    expect(() => decrypt("not-base64-!!!", MFA_CONTEXT)).toThrow();
    expect(() => decrypt(Buffer.from([1, 2, 3]).toString("base64"), MFA_CONTEXT)).toThrow();
  });
});
