import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { type Request } from "express";
import { appError } from "../utils/errors";
import config from "../config";
import { RedisRateLimitStore } from "../lib/rateLimitStore";

const MINUTE = 60 * 1000;
const UNKNOWN_IP = "unknown";

/**
 * Integration suites hammer the same endpoints repeatedly, so limits are off
 * under NODE_ENV=test by default. The rate-limit tests themselves flip this
 * back on for the duration of their assertions.
 */
let enabled = config.node_env !== "test";

export function setRateLimitingEnabled(value: boolean) {
  enabled = value;
}

/**
 * express-rate-limit inspects the key generator's source text to catch IPv6
 * bypasses, so any generator touching req.ip must call ipKeyGenerator in its
 * own body rather than delegating to a helper.
 */
const byIp = (req: Request) => ipKeyGenerator(req.ip ?? UNKNOWN_IP);

/**
 * Keys on the submitted email so a distributed attacker cannot spread a
 * password-guessing run for one account across many source addresses. The
 * project id is part of the key too, so identical email addresses in two
 * different projects never share a throttle bucket.
 */
const byAccount = (req: Request) => {
  const email: unknown = req.body?.email;

  if (
    typeof email !== "string" ||
    email.trim().length === 0 ||
    !req.projectId
  ) {
    return `ip:${ipKeyGenerator(req.ip ?? UNKNOWN_IP)}`;
  }

  return `account:${req.projectId}:${email.trim().toLowerCase()}`;
};

/**
 * The default memory store is per-process. The auth-sensitive limiters below
 * therefore share counts through Redis (ADR 0005), namespaced per limiter
 * because several key on the same IPs and must never share a bucket.
 */
function limiter(options: Partial<Options> & { storePrefix?: string }) {
  const { storePrefix, ...rateLimitOptions } = options;

  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => !enabled,
    handler: (_req, _res, next) =>
      next(appError(429, "Too many requests", "rate_limited")),
    ...rateLimitOptions,
    ...(storePrefix
      ? { store: new RedisRateLimitStore(storePrefix) }
      : {}),
  });
}

/**
 * Deliberately NOT shared (no storePrefix): its job is absorbing floods, not
 * precision enforcement — a per-instance cap of 300 still caps each replica
 * at 300, and keeping it off Redis keeps the hot path free of a round-trip
 * on every request.
 */
export const globalLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 300,
  keyGenerator: byIp,
});

export const loginIpLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 30,
  storePrefix: "login-ip",
  keyGenerator: byIp,
});

export const loginAccountLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 8,
  skipSuccessfulRequests: true,
  storePrefix: "login-account",
  keyGenerator: byAccount,
});

export const registerLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 10,
  storePrefix: "register",
  keyGenerator: byIp,
});

export const refreshLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 60,
  storePrefix: "refresh",
  keyGenerator: byIp,
});

/**
 * Recovery flows send email, so the per-account limit is the one that matters:
 * without it an attacker can mailbomb a known address from many sources.
 */
export const recoveryLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 5,
  storePrefix: "recovery",
  keyGenerator: byAccount,
});

/**
 * Guessing a 256-bit recovery token is not the threat here; this just stops a
 * client from hammering the endpoint.
 */
export const tokenSubmissionLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 20,
  storePrefix: "token-submission",
  keyGenerator: byIp,
});

export const oauthLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 40,
  storePrefix: "oauth",
  keyGenerator: byIp,
});
