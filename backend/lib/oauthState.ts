import crypto from "node:crypto";
import { generateState } from "arctic";
import { derivedKey } from "./cryptoBox";

/**
 * The OAuth redirect flow carries the Project id inside `state` rather than a
 * separate cookie, so a stripped or swapped cookie cannot misroute a callback
 * onto another Project's credentials (ADR 0009). `state` is
 * `<random>.<projectId>.<hmacHex>`: the random half is the CSRF nonce that
 * must echo back in the `kauth_oauth_state` cookie, the HMAC makes the
 * projectId tamper-evident.
 *
 * The HMAC key is its own subkey off the shared ENCRYPTION_KEY — distinct from
 * cookie signing and the MFA secret, per ADR 0006's blast-radius rule.
 */
const STATE_CONTEXT = "kauth:oauth-state";

function sign(payload: string) {
  return crypto
    .createHmac("sha256", derivedKey(STATE_CONTEXT))
    .update(payload)
    .digest("hex");
}

export function signState(projectId: string): string {
  const payload = `${generateState()}.${projectId}`;

  return `${payload}.${sign(payload)}`;
}

export function verifyState(
  value: string,
): { random: string; projectId: string } | null {
  const parts = value.split(".");

  if (parts.length !== 3) {
    return null;
  }

  const [random, projectId, mac] = parts;

  if (!random || !projectId || !mac) {
    return null;
  }

  const expected = Buffer.from(sign(`${random}.${projectId}`), "hex");
  const provided = Buffer.from(mac, "hex");

  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  return { random, projectId };
}
