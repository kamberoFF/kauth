import crypto from "node:crypto";
import { decodeBase32, encodeBase32NoPadding } from "@oslojs/encoding";
import { createTOTPKeyURI, verifyHOTP } from "@oslojs/otp";

/**
 * Pure TOTP helpers (RFC 6238 defaults): SHA-1, 6 digits, 30-second period,
 * ±1 step verification window. The secret is stored base32-encoded and the
 * otpauth URI is what the client renders as a QR — this module never touches
 * the database or the encrypted column.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

const SECRET_BYTES = 20;
const VERIFY_WINDOW_STEPS = 1n;

/** A fresh enrollment secret: 20 random bytes as RFC 4648 base32. */
export function generateTotpSecret() {
  return encodeBase32NoPadding(crypto.randomBytes(SECRET_BYTES));
}

/**
 * The URI an authenticator app imports. `accountName` is whatever is least
 * leaky at the call site — the project-scoped email or username.
 */
export function buildOtpauthUri(accountName: string, secretBase32: string) {
  return createTOTPKeyURI(
    "kauth",
    accountName,
    decodeBase32(secretBase32),
    TOTP_PERIOD_SECONDS,
    TOTP_DIGITS,
  );
}

/**
 * Returns the counter step a code matches within the ±1-step window, or null
 * when it matches none. Callers persist the matched step for replay defense:
 * any later code at or below the recorded step must be rejected.
 */
export function matchTotpStep(secretBase32: string, code: string, now = new Date()) {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  const key = decodeBase32(secretBase32);
  const currentStep = BigInt(Math.floor(now.getTime() / (TOTP_PERIOD_SECONDS * 1000)));

  for (let offset = -VERIFY_WINDOW_STEPS; offset <= VERIFY_WINDOW_STEPS; offset++) {
    const candidate = currentStep + offset;

    if (candidate < 0n) {
      continue;
    }

    if (verifyHOTP(key, candidate, TOTP_DIGITS, code)) {
      return Number(candidate);
    }
  }

  return null;
}
