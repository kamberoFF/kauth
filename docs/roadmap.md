# Roadmap

**Living document.** Unlike the dated audit and remediation logs, this file is
kept current — if it disagrees with the code, the file is wrong.

Last reviewed: 2026-08-23.

**Multi-tenancy pivot in progress.** As of 2026-08-22 kauth is being extended
into a self-hosted, multi-tenant auth platform — see
`.scratch/clerk-clone/map.md` and its `clerk-clone-foundation` tickets.
Tickets 01–04 (the `Project` entity, project-scoping across the full auth
surface, developer-facing auth bootstrap, and per-project API key issuance)
are done and merged, plus a same-day gap-closing ticket on audit-log
project scoping and OAuth validation hygiene; the item below still applies
to everything built *before* this pivot started, and multi-tenancy itself is
no longer "deliberately last" — see the map's reconciliation note for why
schema work went ahead of the rest of this backlog. Tickets 05/06 (the SDK
packages) are next in the tracker's dependency graph, but see "Before
starting the SDK" below — that gate is still active and unmet.

It replaces the five-phase hardening plan that used to live in `backend/docs/`.
That plan was written in June 2026, before any of it was built; the parts that
have since been implemented are recorded in the remediation logs, and what
remained useful has been folded in below.

## Done

Enough context to read the rest of this file.

- **Sessions** — server-owned, revocable, with device and IP metadata. Access
  tokens carry a `sid` claim and are checked against the session row on every
  request, so revocation is immediate.
- **Refresh** — opaque `selector.verifier` credentials, verifier stored only as
  a hash, one-time-use with rotation, family tracking, and reuse detection that
  revokes the family. A server-initiated revocation is correctly distinguished
  from theft.
- **Transport** — `HttpOnly` cookies by default, body tokens on explicit
  opt-in, bearer taking precedence over cookie.
- **Social login** — Google and GitHub via arctic, an `accounts` table in the
  better-auth shape, email-verified linking policy, code-based callback
  exchange, and a registration hook for further providers.
- **Recovery** — email verification and password reset on single-use hashed
  tokens; a completed reset revokes every session.
- **Abuse controls** — per-IP and per-account rate limits, stateless signed
  double-submit CSRF, trusted-origin validation.
- **Audit log** — `security_events` written for every auth-relevant transition,
  with severity derived from the event type rather than the call site.
- **Verification** — 96 integration tests against real Postgres covering abuse
  cases (reuse, revoked-session access, throttling, device mismatch, CSRF), run
  in CI alongside typecheck, lint, and `bun audit`.

## Next

Ordered by what unblocks or protects the most.

### 1. Operations

The only area with nothing done in it, and none of it touches the auth contract.

- Run the container as non-root, on a minimal production image, with no dev bind
  mounts. `oven/bun` already ships a `bun` user.
- Apply `prisma migrate deploy` at startup rather than only `generate` at build.
- Graceful shutdown: stop accepting work on `SIGTERM`, close the server, then
  disconnect Prisma. `tests/helpers/api.ts` already does this correctly and is a
  usable model.
- Structured logging with correlation fields — request id, user id, session id,
  route, outcome code. Application logs and audit events stay separate concerns:
  the audit log already exists and should not be diluted into log text.
- Split `/health` into liveness and readiness, with readiness reflecting
  database connectivity, so deployment automation can act on it.
- A cleanup job for revoked sessions and consumed refresh tokens, which
  currently accumulate by design.

### 2. Password hashing

- Move to Argon2id, benchmarked to 250–400 ms on the deployment target.
- Migrate transparently by rehashing on successful login.
- Raise the minimum length toward NIST-4's 15 characters for single-factor, and
  add an HIBP breach check. The 72-byte cap can go once bcrypt does.

### 3. Close the identity oracles

- Registration returns 409 on a duplicate email, which tells an unauthenticated
  caller whether an account exists.
- Login short-circuits before hashing when the user is unknown, so response
  timing distinguishes the two cases. Hash against a dummy value instead.

### 4. Session policy

- Make `device_id` server-issued. Today the client supplies it, so it is a risk
  signal being used as an auth decision.
- Add sliding expiry and an inactivity timeout. `last_used_at` is written on
  every refresh and never read for policy.

### 5. Multi-instance readiness

- The rate limiter's default store is per-process, so every limit becomes
  per-replica the moment kauth runs more than once. Needs a shared store.

### 6. Features

Deliberately last: none of them are worth building on a foundation that still
has the items above open.

- MFA (TOTP) and passkeys.
- RBAC enforcement. `Role` exists on the user, appears in no token, and gates
  nothing.
- Multi-tenancy.
- Asymmetric access-token signing with `kid` and a key-rotation policy, if other
  services ever need to verify tokens without sharing the secret.

## Before starting the SDK

The SDK is the reason the contract has to settle first — a public wrapper turns
today's mistakes into permanent ones. Start it when all of these hold:

- Session rotation and revocation rules are stable. **Done.**
- Token transport is final for the supported client types. **Done.**
- Core auth events are observable. Partly — the audit log exists, structured
  logging does not.
- Integration tests protect the main flows. **Done.**
- The response and error contract is versioned and consistent. **Done**
  2026-08-23 — see ADR 0003: an `X-Kauth-Contract-Version` header, exact-match
  SDK enforcement, no multi-version hosting (kauth is self-hosted
  per-operator, never one instance serving many independently-upgrading
  callers). Not yet implemented in code — the decision is recorded, the
  header/check itself still needs building (part of tickets 05/06, since
  it's the SDKs that enforce it).

So: after the operations work. (The versioning decision itself is done; see
above — what's left of this gate is the operations backlog.)

**Confirmed via `/domain-modeling` 2026-08-23.** Tickets 05/06 (backend and
client SDK packages) show as `ready-for-agent` in
`.scratch/clerk-clone-foundation/issues/` — their only *ticket-tracker*
blocker (04, API key issuance) is done — but that graph doesn't encode this
gate. Operations hardening (section "1. Operations" above) still hasn't
happened, so it remains a real, deliberate blocker on 05 and 06 beyond what
the ticket tracker shows, not a stale leftover from before the pivot.
Revisit only by explicitly re-deciding this, not by treating "04 is done" as
sufficient.

## Deliberately not doing

- **Becoming an OIDC provider.** kauth authenticates users for first-party
  apps; it is not an identity provider other applications integrate against.
  This is a product decision, not a backlog item.
- **A DB-backed CSRF token.** The `csrf_tokens` table is dead schema — the
  stateless signed approach is no weaker and costs no query. The table should be
  dropped.
- **Caching the session lookup in `requireAuth`.** A cache reintroduces exactly
  the staleness window that binding tokens to sessions closed. Revisit only if
  profiling shows a real problem.
