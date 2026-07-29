import crypto from "node:crypto";
import { type Response, type RequestHandler } from "express";
import config from "../config";
import { CSRF_COOKIE, CSRF_TOKEN_HEADER } from "../constants/headers";
import { csrfCookieOptions } from "../config/cookies";
import { appError } from "../utils/errors";
import { tryRecordSecurityEvent } from "../lib/securityEvents";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOKEN_BYTES = 32;

function sign(token: string) {
  return crypto
    .createHmac("sha256", config.cookie_secret)
    .update(token)
    .digest("base64url");
}

function equals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return (
    left.length === right.length && crypto.timingSafeEqual(left, right)
  );
}

/**
 * Signed double-submit: the cookie carries `token.signature`, and the client
 * echoes that same string back in a header. The signature is what stops an
 * attacker on a sibling subdomain from planting a cookie value of their own
 * choosing, which is the weakness of the naive double-submit pattern.
 */
export function issueCsrfToken(res: Response) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const value = `${token}.${sign(token)}`;

  res.cookie(CSRF_COOKIE, value, csrfCookieOptions);

  return value;
}

function isWellFormed(value: string) {
  const [token, signature, ...rest] = value.split(".");

  if (!token || !signature || rest.length > 0) {
    return false;
  }

  return equals(sign(token), signature);
}

/**
 * Enforced only for requests that carry cookies. A request with no cookies has
 * no ambient authority for an attacker to borrow, and bearer tokens cannot be
 * attached by a cross-site page. This makes the check self-activating the
 * moment session cookies are introduced, without breaking header-based clients.
 */
export const requireCsrfToken: RequestHandler = async (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const cookies = req.cookies as Record<string, string> | undefined;

  if (!cookies || Object.keys(cookies).length === 0) {
    return next();
  }

  const presented = req.get(CSRF_TOKEN_HEADER);
  const stored = cookies[CSRF_COOKIE];

  if (!stored || !presented || !equals(stored, presented) || !isWellFormed(stored)) {
    await tryRecordSecurityEvent({
      type: "CSRF_VALIDATION_FAILED",
      userId: req.userId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: {
        path: req.path,
        reason: !stored
          ? "cookie_missing"
          : !presented
            ? "header_missing"
            : "mismatch",
      },
    });

    return next(appError(403, "Invalid CSRF token", "csrf_invalid"));
  }

  next();
};
