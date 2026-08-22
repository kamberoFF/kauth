import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { prisma } from "./prisma";
import {
  API_KEY_HASH_ROUNDS,
  PUBLISHABLE_KEY_PREFIX,
  SECRET_KEY_PREFIX,
} from "../constants/apiKeys";
import type { ApiKey } from "../generated/prisma/client";

function randomToken(bytes: number) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Publishable keys are meant to ship in a browser/mobile bundle, so the full
 * value is stored and re-served in full — there is nothing to hide.
 */
export function generatePublishableKey() {
  const raw = `${PUBLISHABLE_KEY_PREFIX}${randomToken(24)}`;
  return { raw, prefix: raw };
}

/**
 * Secret keys reuse RefreshToken's selector+verifier split: the selector
 * (here, the whole "sk_..." prefix before the dot) is stored in plaintext for
 * O(1) lookup, and only the verifier is bcrypt-hashed. Returning both the raw
 * value and prefix separately keeps the caller from having to re-derive one
 * from the other.
 */
export async function generateSecretKey() {
  const selector = `${SECRET_KEY_PREFIX}${randomToken(9)}`;
  const verifier = randomToken(32);
  const hash = await bcrypt.hash(verifier, API_KEY_HASH_ROUNDS);

  return { raw: `${selector}.${verifier}`, prefix: selector, hash };
}

/** Distinguishes "no such key" from "key exists but was revoked" without a second query. */
export type ApiKeyResolution = ApiKey | "revoked" | null;

/**
 * Parses and resolves a presented key against the database without ever
 * comparing plaintext secrets: publishable keys are looked up by full value
 * (they're not secret), secret keys are looked up by their selector prefix
 * then bcrypt-verified, the same two-step shape refresh-token consumption
 * uses.
 */
export async function resolveApiKey(raw: string): Promise<ApiKeyResolution> {
  if (raw.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    const row = await prisma.apiKey.findUnique({ where: { key_value: raw } });

    if (!row) return null;
    return row.revoked_at ? "revoked" : row;
  }

  if (raw.startsWith(SECRET_KEY_PREFIX)) {
    const [prefix, verifier] = raw.split(".");

    if (!prefix || !verifier) return null;

    const row = await prisma.apiKey.findUnique({
      where: { key_prefix: prefix },
    });

    if (!row || row.key_type !== "SECRET" || !row.key_hash) return null;
    if (!(await bcrypt.compare(verifier, row.key_hash))) return null;

    return row.revoked_at ? "revoked" : row;
  }

  return null;
}
