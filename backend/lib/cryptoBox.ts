import crypto from "node:crypto";
import config from "../config";

/**
 * AES-256-GCM encryption for data that must be recoverable at rest — today
 * the TOTP shared secret, so enrollment survives server restarts and an
 * authenticator can stay in sync (ADR 0006). Each consumer names its own
 * key-derivation context (see below). Payload layout is
 * base64(iv ‖ tag ‖ ciphertext) with a fresh random IV per call.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Namespaced key derivation: each consumer passes its own context label so it
 * derives a distinct subkey from the shared ENCRYPTION_KEY, and a ciphertext
 * sealed under one context never verifies under another (distinct key + the
 * GCM auth tag). Exported so non-cipher consumers of the same secret — the
 * signed OAuth `state` HMAC — share the one blast-radius rule (ADR 0006)
 * structurally rather than by copy-paste.
 */
export function derivedKey(context: string) {
  return crypto
    .createHash("sha256")
    .update(config.encryption_key)
    .update(context)
    .digest();
}

export function encrypt(plaintext: string, context: string) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey(context), iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decrypt(payload: string, context: string) {
  const raw = Buffer.from(payload, "base64");

  // Ciphertext itself may be empty (GCM is a stream cipher), so the floor is
  // exactly iv + tag.
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Encrypted payload is too short to be well-formed");
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    derivedKey(context),
    iv,
  );
  decipher.setAuthTag(tag);

  // GCM verifies the auth tag during final(); any tamper throws here.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
