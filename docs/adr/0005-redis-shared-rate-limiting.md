# Redis as a second infrastructure dependency for shared rate limiting

kauth's storage story was deliberately "one Postgres" — see ADR 0001's
spirit of minimal infrastructure. This ADR records deliberately breaking
that: as of 2026-08-24, kauth also requires a Redis instance in every
deployment.

## Context

The rate limiter's default store is per-process. The moment kauth runs more
than one replica, every abuse-control limit (login throttling, recovery
mailbombing protection, registration caps) silently becomes per-replica —
an attacker multiplying their effective limit by replica count is exactly
the distributed-attack shape these limits exist to stop.

## Decision

The seven auth-sensitive limiters count against Redis through a small custom
store (`backend/lib/rateLimitStore.ts`, `ioredis`): one atomic EVAL per hit
(`INCR` + first-hit `PEXPIRE` + `PTTL` read), keys namespaced per limiter so
limiters keying on the same IP never share a bucket.

Two deliberate softenings:

1. **Degradation, not failure.** When Redis is unreachable, affected
   limiters fall back to per-instance memory counting and log a warning;
   they probe back to shared counting automatically. Degraded throttling is
   strictly better than dead auth.
2. **The global flood-absorbing limiter stays in-memory.** Its job is
   absorbing floods, not precision enforcement; keeping it off Redis keeps
   the hot path free of a round-trip on every request.

## Alternatives considered

- **Postgres-backed store** (`rate_limit_hits` table): no new dependency,
  but under a flood the limiter itself becomes a write load on the auth OLTP
  database — the throttle path turning into a DoS vector against the very
  thing that must stay healthy was the decisive argument against.
- **Fail-closed without fallback**: simpler reasoning, but couples auth
  availability to a cache tier; rejected for an auth service.

## Consequences

- Every deployment guide gains a Redis service (see `docker-compose.yml`);
  `REDIS_URL` configures it and defaults to localhost.
- Expiry is native TTL — no cleanup-job involvement, unlike other retention
  concerns (ADR 0004).
- Redis becomes available for future cross-instance primitives (caching,
  pub/sub) but nothing else uses it today; it is not a general-purpose cache
  tier yet.
