import { describe, expect, it } from "bun:test";
import Redis from "ioredis";
import type { Options } from "express-rate-limit";
import {
  RedisRateLimitStore,
  clearAllRateLimitKeys,
} from "../lib/rateLimitStore";

/**
 * The property this whole feature exists for: counts are visible across
 * independent store instances, because that is what separate replicas of the
 * server each holding their own store would see.
 */
function asOptions(windowMs: number) {
  return { windowMs } as Options;
}

describe("shared counting across instances", () => {
  it("shows one instance's increments to another", async () => {
    const replicaA = new RedisRateLimitStore("replica-test");
    const replicaB = new RedisRateLimitStore("replica-test");

    await clearAllRateLimitKeys();

    await replicaA.init(asOptions(60_000));
    await replicaB.init(asOptions(60_000));

    await replicaA.increment("1.2.3.4");
    await replicaA.increment("1.2.3.4");

    const seen = await replicaB.get("1.2.3.4");
    expect(seen?.totalHits).toBe(2);

    // And both replicas push the same counter forward.
    const third = await replicaB.increment("1.2.3.4");
    expect(third.totalHits).toBe(3);
    expect(third.resetTime).toBeInstanceOf(Date);
  });

  it("keeps different limiters' buckets separate", async () => {
    const loginIp = new RedisRateLimitStore("iso-login-ip");
    const refresh = new RedisRateLimitStore("iso-refresh");

    await loginIp.init(asOptions(60_000));
    await refresh.init(asOptions(60_000));

    // The same key (same IP) under two limiters must not share a bucket.
    await loginIp.increment("2.3.4.5");

    const refreshed = await refresh.increment("2.3.4.5");
    expect(refreshed.totalHits).toBe(1);
  });

  it("expires windows by TTL without any cleanup step", async () => {
    const store = new RedisRateLimitStore("ttl-test");
    await store.init(asOptions(120));

    await store.increment("3.4.5.6");
    await store.increment("3.4.5.6");

    await Bun.sleep(200);

    const afterExpiry = await store.increment("3.4.5.6");
    expect(afterExpiry.totalHits).toBe(1);
    expect(afterExpiry.resetTime!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("degradation to per-instance memory", () => {
  it("still counts — locally only — when redis is unreachable", async () => {
    // An earlier run may have counted into this prefix through the healthy
    // path; buckets must start empty like any other test fixture.
    await clearAllRateLimitKeys();

    const dead = new Redis("redis://127.0.0.1:5990", {
      lazyConnect: false,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });

    try {
      const store = new RedisRateLimitStore("degraded-test", dead);
      await store.init(asOptions(60_000));

      const first = await store.increment("9.9.9.9");
      const second = await store.increment("9.9.9.9");

      expect(first.totalHits).toBe(1);
      expect(second.totalHits).toBe(2);

      // A healthy store instance is unaffected: the degraded one fell back
      // rather than taking the shared path down with it.
      const shared = new RedisRateLimitStore("degraded-observer");
      await shared.init(asOptions(60_000));
      const observed = await shared.get("9.9.9.9");
      expect(observed?.totalHits).toBeUndefined();
    } finally {
      dead.disconnect();
    }
  });
});

