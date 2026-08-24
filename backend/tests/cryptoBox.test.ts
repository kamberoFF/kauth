import { describe, expect, it } from "bun:test";
import { decrypt, encrypt } from "../lib/cryptoBox";

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
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    }
  });

  it("produces different ciphertexts for the same input (random IV)", () => {
    const first = encrypt("same input");
    const second = encrypt("same input");

    expect(first).not.toBe(second);
    // Both must still decrypt to the original.
    expect(decrypt(first)).toBe("same input");
    expect(decrypt(second)).toBe("same input");
  });

  // Mutation check (named, per repo convention): make decrypt swallow
  // decipher.final()'s auth failure and return the raw ciphertext instead —
  // both tamper tests below go red. Restoring the throw turns them green.

  it("throws when a ciphertext bit is flipped (auth tag mismatch)", () => {
    const payload = Buffer.from(encrypt("tamper me"), "base64");

    // Flip one bit in the middle of the ciphertext body.
    const last = payload.length - 1;
    payload.writeUInt8(payload.readUInt8(last) ^ 0x01, last);

    expect(() => decrypt(payload.toString("base64"))).toThrow();
  });

  it("throws when the tag itself is tampered with", () => {
    const payload = Buffer.from(encrypt("tamper me"), "base64");

    // iv(12) ‖ tag(16) ‖ ciphertext — flip a bit inside the tag.
    payload.writeUInt8(payload.readUInt8(13) ^ 0x80, 13);

    expect(() => decrypt(payload.toString("base64"))).toThrow();
  });

  it("throws when truncated or malformed payloads are presented", () => {
    expect(() => decrypt("not-base64-!!!")).toThrow();
    expect(() => decrypt(Buffer.from([1, 2, 3]).toString("base64"))).toThrow();
  });
});
