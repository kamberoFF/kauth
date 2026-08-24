import Redis from "ioredis";
import type {
  ClientRateLimitInfo,
  Options,
  Store,
} from "express-rate-limit";
import config from "../config";
import { logger } from "./logger";

/**
 * A shared fixed-window counter store for express-rate-limit (ADR 0005).
 *
 * Counts live in Redis so limits hold across replicas; each limiter gets its
 * own key prefix because several of them key on the same IP addresses and
 * must never share a bucket. When Redis is unreachable the store degrades to
 * per-instance memory counting with a loud warning — degraded throttling is
 * strictly better than dead auth, and strictly worse than shared counting,
 * which is why the state transition is logged both ways.
 */

// One round-trip per increment: INCR, expire on first hit, read back the TTL
// so every replica agrees on when the window ends. EVAL guarantees atomicity.
const INCREMENT_SCRIPT = `
local hits = redis.call("INCR", KEYS[1])
if hits == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return {hits, redis.call("PTTL", KEYS[1])}
`;

let sharedClient: Redis | undefined;

function client() {
  sharedClient ??= new Redis(config.redis_url, {
    // Reconnect forever but back off; the fallback covers the gaps.
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
    maxRetriesPerRequest: 1,
  });

  return sharedClient;
}

let degraded = false;
let lastRecoveryProbe = 0;
const fallback = new Map<string, { totalHits: number; resetTime: Date }>();

// Deliberately process-wide, not per-instance: production has exactly one
// shared connection per process (see client()), so one limiter discovering
// Redis is down means every limiter's next call would fail too. The tests
// inject a second connection and rely on this same coupling.

// While degraded, one cheap PING every few seconds decides whether traffic
// can move back to Redis — no reliance on client connection events, which
// do not fire for an already-idle connection.
const RECOVERY_PROBE_MS = 5_000;

function degrade(reason: unknown) {
  if (!degraded) {
    degraded = true;
    logger.warn("rate limiting degraded to per-instance memory", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }
}

/** Memory window mirroring the Redis one while degraded. */
function memoryIncrement(
  fullKey: string,
  windowMs: number,
): ClientRateLimitInfo {
  const now = Date.now();
  const entry = fallback.get(fullKey);

  if (!entry || entry.resetTime.getTime() <= now) {
    const fresh = { totalHits: 1, resetTime: new Date(now + windowMs) };
    fallback.set(fullKey, fresh);
    return { ...fresh };
  }

  // Callers get a copy: handing out the live entry would let every later
  // hit visibly mutate results a caller is still holding.
  entry.totalHits += 1;
  return {
    totalHits: entry.totalHits,
    resetTime: new Date(entry.resetTime),
  };
}

/** Read-side twin of memoryIncrement: same copy semantics, no mutation. */
function memoryGet(fullKey: string): ClientRateLimitInfo | undefined {
  const entry = fallback.get(fullKey);
  if (!entry) return undefined;
  return {
    totalHits: entry.totalHits,
    resetTime: new Date(entry.resetTime),
  };
}

/** Closes the shared connection — called from graceful shutdown. */
export function closeRateLimitRedis() {
  sharedClient?.disconnect();
  sharedClient = undefined;
  fallback.clear();
  degraded = false;
}

/**
 * Clears every rate-limit key — used by the test harness between scenarios so
 * throttle buckets cannot leak across tests. Never called in production:
 * keys expire by TTL. Pointed at whatever REDIS_URL says; on a Redis shared
 * with other applications, that application should own a distinct DB index.
 */
export async function clearAllRateLimitKeys() {
  const redis = client();

  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      "rl:*",
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

export class RedisRateLimitStore implements Store {
  localKeys = false;

  // Store itself carries an optional `prefix` member for its own validation
  // warnings; the limiter's namespace lives in keyPrefix.
  private readonly keyPrefix: string;
  private readonly redis?: Redis;
  private windowMs = 60_000;

  // The injected client exists for tests (an unreachable connection proves
  // the fallback); production always uses the shared one.
  constructor(prefix: string, redis?: Redis) {
    this.keyPrefix = `rl:${prefix}`;
    this.redis = redis;
  }

  private connection(): Redis {
    return this.redis ?? client();
  }

  private keyFor(key: string) {
    return `${this.keyPrefix}:${key}`;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  private async tryRestore(): Promise<boolean> {
    if (Date.now() - lastRecoveryProbe < RECOVERY_PROBE_MS) return false;

    lastRecoveryProbe = Date.now();
    try {
      await this.connection().ping();
      degraded = false;
      fallback.clear();
      logger.info("rate limiting restored to shared redis store");
      return true;
    } catch {
      return false;
    }
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const fullKey = this.keyFor(key);

    if (degraded && !(await this.tryRestore())) {
      return memoryIncrement(fullKey, this.windowMs);
    }

    try {
      const [hits, ttl] = (await this.connection().eval(
        INCREMENT_SCRIPT,
        1,
        fullKey,
        String(this.windowMs),
      )) as [number, number];

      return {
        totalHits: Number(hits),
        // PTTL is -1 without a TTL and -2 on a missing key; either way the
        // window is effectively over, so reset immediately rather than
        // advertising a bogus horizon.
        resetTime: new Date(
          Number(ttl) > 0 ? Date.now() + Number(ttl) : Date.now(),
        ),
      };
    } catch (error) {
      degrade(error);
      return memoryIncrement(fullKey, this.windowMs);
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const fullKey = this.keyFor(key);

    if (degraded && !(await this.tryRestore())) {
      return memoryGet(fullKey);
    }

    try {
      const redis = this.connection();
      const [hits, ttl] = await Promise.all([
        redis.get(fullKey),
        redis.pttl(fullKey),
      ]);

      if (hits === null || Number(ttl) <= 0) return undefined;

      return {
        totalHits: Number(hits),
        resetTime: new Date(Date.now() + Number(ttl)),
      };
    } catch (error) {
      degrade(error);
      return memoryGet(fullKey);
    }
  }

  async decrement(key: string): Promise<void> {
    if (degraded) return;

    try {
      await this.connection().incrby(`${this.keyPrefix}:${key}`, -1);
    } catch (error) {
      degrade(error);
    }
  }

  async resetKey(key: string): Promise<void> {
    fallback.delete(`${this.keyPrefix}:${key}`);

    if (degraded) return;

    try {
      await this.connection().del(`${this.keyPrefix}:${key}`);
    } catch (error) {
      degrade(error);
    }
  }

  shutdown() {
    fallback.clear();
  }
}



