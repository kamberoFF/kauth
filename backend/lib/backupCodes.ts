import crypto from "node:crypto";
import { encodeBase32NoPadding } from "@oslojs/encoding";

/**
 * Single-use recovery codes shown once at enrollment and stored only as
 * SHA-256 hashes — same justification as recovery tokens.
 *
 * The format (8 RFC 4648 base32 chars = 40 bits) trades raw entropy for
 * typeability, which is the point of a code a user reads off paper while an
 * authenticator is unavailable. Online guessing is bounded by the token
 * submission limiter, each correct guess burns exactly one code and raises a
 * WARNING audit event, and enrollment revokes nothing by itself — the residual
 * offline-guessing risk per hash is judged acceptable for that role. A longer
 * format would push users back toward storing codes in password managers they
 * may be locked out of; revisit only if a real threat model demands it.
 */
export const BACKUP_CODE_COUNT = 10;

// 8 base32 characters encode exactly 5 bytes with no padding.
const CODE_BYTES = 5;

/**
 * Canonical form used for hashing and later matching: case-insensitive and
 * dash-insensitive, so "abcd-ef23", "ABCDEF23" and "ab cd ef 23" all compare
 * equal. Presentation keeps the dash; storage never sees it.
 */
export function normalizeBackupCode(input: string) {
  return input.replaceAll(/[\s-]/g, "").toUpperCase();
}

function generateBackupCode() {
  const encoded = encodeBase32NoPadding(crypto.randomBytes(CODE_BYTES));

  return `${encoded.slice(0, 4)}-${encoded.slice(4)}`;
}

/** Fresh display codes; callers persist `hashBackupCode` of each. */
export function generateBackupCodes() {
  return Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
}

export function hashBackupCode(code: string) {
  return crypto.createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}
