Status: ready-for-agent

# kauth Operations Hardening

Collapsed from a `/grilling` session (via `/grill-with-docs`) that worked
`docs/roadmap.md`'s "1. Operations" backlog to an empty frontier — 13
decisions, each put to the user and answered, informed by two rounds of
read-only exploration and two rounds of web research (Bun/Prisma image
compatibility, pino-on-Bun). This spec is the buildable synthesis; the
grilling transcript and `docs/adr/0004-coordinated-session-audit-retention.md`
remain the primary sources for the reasoning behind the one genuinely
architectural call (coordinated session/audit-log deletion).

## Problem Statement

`docs/roadmap.md` calls operations hardening "the only area with nothing
done in it" — and it's the last blocker on tickets 05/06 (the SDK packages),
per the roadmap's "Before starting the SDK" gate (the API-versioning half of
that gate is already resolved, ADR 0003). Six concrete gaps: the container
runs as root with no healthcheck, migrations are a manual pre-step nobody
automated, there's no graceful shutdown, all logging is unstructured
`console.*`, `/health` has no real readiness signal, and revoked
sessions/consumed refresh tokens accumulate forever with no cleanup
mechanism.

## Solution

Harden each of the six areas to a shippable, tested state, without touching
the auth contract itself — the roadmap is explicit that none of this backlog
touches auth logic. One coupled exception: the cleanup job's session-deletion
half required resolving a real conflict between the roadmap's request and
`CLAUDE.md`'s "sessions are revoked, never deleted" invariant — resolved via
a coordinated retention ordering (ADR 0004), not by ignoring either
constraint.

## User Stories

1. As a platform operator, I want the container to run as a non-root user, so that a container escape or dependency RCE doesn't hand an attacker root inside the box.
2. As a platform operator, I want a container-level healthcheck, so my orchestrator can detect a wedged process without relying solely on external monitoring.
3. As a platform operator, I want `prisma migrate deploy` to run automatically at startup, so deploying a new version doesn't require a separate manual migration step I could forget.
4. As a platform operator, I want a failed startup migration to crash the process loudly, so I notice immediately rather than serving traffic against a stale or broken schema.
5. As a platform operator, I want the server to drain in-flight requests and disconnect cleanly on SIGTERM, so a rolling deploy doesn't cut off requests mid-flight or leak database connections.
6. As a platform operator, I want a bounded shutdown timeout, so one stuck connection can't block cleanup long enough that my orchestrator SIGKILLs the process before `prisma.$disconnect()` runs.
7. As a platform operator, I want structured, correlatable logs (request id, user id, session id, route, outcome code), so I can actually trace a single request's path through the system instead of grepping unstructured lines.
8. As a platform operator, I want application logs kept fully separate from the audit log, so operational noise never dilutes the security-relevant record `SecurityEvent` already provides.
9. As a platform operator, I want `/health` to stay a pure liveness check and a new endpoint to reflect real database connectivity, so my orchestrator can tell "the process is alive" apart from "the process can actually serve requests" and act on each correctly.
10. As a platform operator, I want consumed/expired refresh tokens purged after a configurable retention window, so their table doesn't grow forever for data with no ongoing value.
11. As a platform operator, I want revoked/expired sessions eventually purged too, so their table doesn't grow forever — but never before every audit event that references them has itself aged out of retention, so the audit trail is never silently severed.
12. As a platform operator, I want both retention windows independently configurable, so I can keep audit/session history as long as compliance requires without being forced to also delay refresh-token cleanup, or vice versa.
13. As a platform operator, I want the cleanup job to be a discrete, externally-triggered step rather than an always-running in-process timer, so its cadence is my choice and the always-on server process stays simple.

## Implementation Decisions

- **Container**: add `USER bun` to `backend/Dockerfile` (the `oven/bun`
  image already ships this user, unused today) and a `HEALTHCHECK`
  instruction hitting `GET /health`. Stay on the current full
  `oven/bun:1.3.14` base — evaluated switching to `-slim` for a smaller
  image with zero Prisma-compatibility cost, deliberately kept the current
  base instead.
- **Migrate-on-startup**: `bunx --bun prisma migrate deploy` (or the
  programmatic equivalent) runs as the first statement inside
  `backend/server.ts`'s `main()`, before `ensurePlatformProject()`. On
  failure: log and `exit(1)` immediately — no retry, no degraded boot. Safe
  under multiple replicas without any extra coordination: Prisma serializes
  concurrent `migrate deploy` invocations via a Postgres advisory lock (a
  non-configurable ~10s wait applies — not a concern at kauth's current
  migration sizes, worth a code comment where the call sits).
- **Graceful shutdown**: port `backend/tests/helpers/api.ts`'s
  `stopTestServer()` pattern into `server.ts` — capture the `http.Server`
  returned by `app.listen`, on `SIGTERM`/`SIGINT` call `server.close()`
  (wrapped in a promise so in-flight requests drain), then
  `prisma.$disconnect()`. Add a 10-second force-exit timeout racing
  `server.close()`, so a stuck connection can't prevent
  `prisma.$disconnect()` from running before an orchestrator's own SIGKILL.
- **Structured logging**: a new `backend/lib/logger.ts`, hand-rolled —
  `console.log(JSON.stringify({ level, msg, ...fields }))` plus a level
  check against a new `LOG_LEVEL` env var. No logging library dependency:
  pino's worker-thread-based transports are confirmed broken under Bun (an
  open, unresolved upstream Bun issue as of this writing), and even pino's
  synchronous fallback path is currently measurably slower under Bun than
  plain `console.log` — not worth the dependency for kauth's ~5 production
  logging call sites regardless. Correlation fields: request id (always
  server-generated via `crypto.randomUUID()` per request, never trusted from
  an inbound header — no existing tracing-header convention in this repo,
  and honoring one unvalidated is log-injection surface for a feature
  nobody's asked for), user id, session id, route, outcome code. A new
  request-scoped middleware mints the id and makes it available to
  downstream handlers/error paths. Existing `console.*` call sites
  (`server.ts`, `middlewares/error.ts`, `lib/securityEvents.ts`'s
  own-failure fallback, `controllers/oauth.ts`, `lib/mail.ts`) migrate to
  the new logger. `SecurityEvent`/`recordSecurityEvent` stays completely
  untouched — application logs and the audit log remain two separate
  mechanisms, per the roadmap's explicit instruction not to dilute one into
  the other.
- **Liveness/readiness**: `GET /health` in `backend/app.ts` stays exactly as
  it is (already documented in `backend/README.md` as liveness). New
  `GET /health/ready`: a trivial `prisma.$queryRaw` round trip; 200 on
  success, 503 with the existing `{ error: { message, code } }` shape (e.g.
  `code: "database_unavailable"`) on failure.
- **Cleanup — config**: two new env vars in `backend/config.ts`, following
  the existing zod-schema-with-`.default()` pattern (see `JWT_SECRET`/
  `COOKIE_SECRET`'s doc-commented production gate as the model for any
  production-only constraints these need):
  - `CLEANUP_RETENTION_DAYS` (default `30`) — governs consumed/expired
    `RefreshToken` rows.
  - `AUDIT_RETENTION_DAYS` (default `365`) — governs `SecurityEvent` rows,
    and gates `Session` row deletion (see below). Kept separate from
    `CLEANUP_RETENTION_DAYS` deliberately — audit/session history plausibly
    needs much longer retention than "clear out stale refresh tokens";
    conflating the two knobs would force operators into a bad trade-off.
- **Cleanup — mechanism**: a new script (e.g. `bun run cleanup`,
  `backend/scripts/cleanup.ts` or similar), not an in-process `setInterval`
  — a discrete, externally-triggered step (cron/orchestrator CronJob),
  matching how migrations are already a discrete operator-triggered action
  in this repo rather than a background timer inside the always-on server.
  In order, within one run:
  1. Delete `RefreshToken` rows that are consumed or expired and older than
     `CLEANUP_RETENTION_DAYS`.
  2. Delete `SecurityEvent` rows older than `AUDIT_RETENTION_DAYS`.
  3. Delete `Session` rows that are revoked or expired **and** older than
     `AUDIT_RETENTION_DAYS` — only after step 2, so nothing still references
     them. `SecurityEvent.session`'s `onDelete: SetNull`
     (`schema.prisma:379`) can then never fire against a live audit record;
     the ordering itself is the guarantee, no extra "does anything still
     reference me" check needed. See ADR 0004 for the full reasoning and its
     stated revisit trigger (an archival approach instead of deletion, if
     ever needed).

## Testing Decisions

- Same seam as the rest of this codebase: real integration tests against a
  real Postgres instance (`bun test`, `beforeEach(resetDatabase)`), no unit
  tier, per this repo's existing convention.
- Shutdown: a test that starts a real server, begins a slow in-flight
  request, sends the process a shutdown signal, and asserts the in-flight
  request completes successfully before the process exits, and that
  `prisma.$disconnect()` is reached. A second test/assertion for the
  force-exit timeout path (a connection that never closes on its own).
- Readiness: a test asserting `GET /health/ready` returns 200 when the DB is
  reachable, and returns 503 with the existing error shape when it isn't
  (e.g. by pointing at a broken connection string in an isolated test
  setup, or by mocking the query call to reject).
- Structured logging: tests assert the correlation fields are present and
  well-formed on a request, and — mutation-checked, per this repo's
  convention for security-relevant guarantees — that `SecurityEvent` writes
  are never duplicated into application logs and application logs never
  contain a token/hash/credential value.
- Cleanup job, the mutation-critical case: seed a `Session` past its own
  expiry/revocation but with a `SecurityEvent` still inside
  `AUDIT_RETENTION_DAYS`; run the cleanup job; assert the session row is
  **not** deleted. Then age the referencing event past retention too; run
  cleanup again; assert the session **is** now deleted. This directly proves
  the ordering guarantee in ADR 0004, not just that "some rows get deleted
  eventually." Also assert `RefreshToken` cleanup respects
  `CLEANUP_RETENTION_DAYS` independently of the audit-retention window.
- Migration-on-startup and container changes are exercised indirectly
  through existing test-server startup (already runs migrations against
  `kauth_test`) rather than a new dedicated integration test — container
  build/healthcheck verification is a manual/CI-level check, not something
  `bun test` covers.

## Out of Scope

- Multi-instance/shared rate-limiter store (a separate item in
  `docs/roadmap.md`'s backlog, "5. Multi-instance readiness" — not part of
  "1. Operations")
- An archival mechanism for old sessions (the ADR 0004 revisit trigger, not
  needed yet)
- Any change to the existing hardening backlog's other sections (password
  hashing, identity oracles, session policy, features) — this spec is
  "1. Operations" only
- Cross-service request tracing (honoring/propagating an inbound
  correlation-id header) — deliberately deferred, see Implementation
  Decisions

## Further Notes

- This spec's completion is what flips `docs/roadmap.md`'s "Before starting
  the SDK" gate to fully done — see that section for the exact checklist
  once all tickets below are merged.
- `docs/adr/0004-coordinated-session-audit-retention.md` is the primary
  source for the cleanup job's session-deletion design; don't re-derive it
  from this spec alone.
- **Tickets to be published** at `.scratch/ops-hardening/issues/`, per
  `/to-tickets` — the cleanup job (refresh-token cleanup, audit-log
  retention, and coordinated session deletion) is one coupled unit and
  should not be split across tickets in a way that separates the ordering
  guarantee from the thing it protects.
