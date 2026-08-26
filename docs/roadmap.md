# Roadmap

**Living document.** Unlike the dated audit and remediation logs, this file is
kept current — if it disagrees with the code, the file is wrong.

Last reviewed: 2026-08-26.

**Multi-tenancy pivot: foundation complete.** As of 2026-08-22 kauth has been
extended into a self-hosted, multi-tenant auth platform — see
`.scratch/clerk-clone/map.md` and its `clerk-clone-foundation` tickets. All
seven are done and merged (2026-08-23/24): the `Project` entity,
project-scoping across the full auth surface, developer-facing auth
bootstrap, per-project API key issuance, both SDK packages (which enforce
ADR 0003's contract-version header), and a same-day gap-closing ticket on
audit-log project scoping and OAuth validation hygiene. The ops-hardening
tickets (structured logging, migrate-on-startup/graceful shutdown,
liveness-readiness split, non-root container, cleanup job) landed the same
week, closing the "Operations" item below; the login timing oracle is closed;
the dead `csrf_tokens` table is dropped; session policy
(server-issued device identity, sliding expiry, inactivity timeout) shipped
2026-08-24; and password hashing moved to Argon2id with a per-Project
password policy on 2026-08-24 (see "Password hashing" below). Multi-instance
readiness landed the same day: the seven auth-sensitive rate limiters now
count against a shared Redis store (ADR 0005), with per-instance memory as
the logged degradation path. MFA — TOTP second factors, backup codes,
two-phase login, and an optional project mandate — shipped 2026-08-25/26
(see "Features" below). **Next up:** what remains of the feature list —
passkeys, RBAC enforcement, and asymmetric access-token signing.

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
- **Multi-tenancy** — every user-owned table project-scoped; a reserved
  platform project dogfoods the same auth stack for developers, who issue
  per-project publishable/secret API keys tier-authorized at the edge.
- **SDKs** — `packages/backend-sdk` (secret-key, contract-version enforcing)
  and `packages/client-sdk` (publishable-key headless auth + React session
  hook).
- **Session policy** — device ids are server-issued (HttpOnly cookie plus
  `deviceId` in session-creating bodies; `X-Device-Id` is an echo channel),
  refresh slides expiry on a rolling 30d window, and an inactivity timeout
  (`SESSION_INACTIVITY_DAYS`, default 14) rejects idle sessions.
- **Audit log** — `security_events` written for every auth-relevant transition,
  with severity derived from the event type rather than the call site.
- **Verification** — 359 integration tests against real Postgres covering
  abuse cases (reuse, revoked-session access, throttling, device mismatch,
  CSRF, MFA challenges), run in CI alongside typecheck, lint, and `bun audit`.

## Next

Ordered by what unblocks or protects the most.

### 1. Operations — done 2026-08-24

Shipped as the `ops-hardening` tickets: non-root container with a liveness
healthcheck, migrate-on-startup with bounded graceful shutdown, structured
logging with request/user/session correlation, liveness/readiness split, and
the coordinated session/audit cleanup job (ADR 0004).

### 2. Password hashing — done 2026-08-24

Shipped in one pass: passwords hash with **Argon2id via `Bun.password`**
(128 MiB / t=3, ~320 ms per hash on the reference hardware; bcrypt remains
only for high-entropy verifiers — refresh tokens, API keys, single-use
tokens). The 72-byte input cap and the rehash-on-login migration were both
mooted by purging dev data before any deployment exists. The login timing
defense carries over unchanged (dummy Argon2id comparison for unknown
accounts).

Alongside it: a **per-Project password policy** — optional
`min_password_length` (8–128) settable at `POST /projects` and changeable by
the owner via `PATCH /projects/:id`; unset falls back to the
`PASSWORD_MIN_LENGTH` env default of 15. Login deliberately has no floor, so
a legacy shorter credential can still sign in. HIBP breach checking was
**declined** (product decision: availability over a third-party dependency,
not deferred). Contract version bumped to 0.3.0 (creation shape grew, new
PATCH route).

### 3. Close the identity oracles — login timing closed 2026-08-24

- ~~Login short-circuits before hashing when the user is unknown, so response
  timing distinguishes the two cases.~~ **Done 2026-08-24** — every login now
  runs exactly one comparison against a dummy hash when no stored credential
  exists (`backend/lib/passwords.ts`).
- Registration returns 409 on a duplicate email, which tells an
  unauthenticated caller whether an account exists. **Deferred as accepted
  residual risk** — fully closing it requires register to stop auto-logging-in
  (a duplicate-email caller cannot receive tokens indistinguishable from the
  happy path), a register-contract change frozen behind ADR 0003's
  `X-Kauth-Contract-Version`. Revisit only by explicitly re-deciding that
  contract question. The `duplicate_username` 409 is not an oracle: usernames
  are user-chosen public handles. See `.scratch/identity-oracles/`.

### 4. Session policy — done 2026-08-24

Shipped as the `session-policy` tickets: device ids are server-issued
(HttpOnly `kauth_device` cookie plus `deviceId` in session-creating response
bodies; `X-Device-Id` survives only as an echo channel), refresh slides
`expires_at` forward on a rolling 30d window, and an inactivity timeout
(default 14 days, `SESSION_INACTIVITY_DAYS`) rejects idle sessions at both
`requireAuth` and refresh.

### 5. Multi-instance readiness — done 2026-08-24

Shipped as the Redis shared rate-limit store (ADR 0005): a custom
express-rate-limit `Store` counting through one atomic EVAL per hit, one key
namespace per limiter, per-instance memory fallback when Redis is
unreachable, and TTL-based expiry so no cleanup path is needed. The global
flood-absorbing limiter deliberately stays in-memory. Verified by a
cross-replica property test (two independent stores see each other's counts)
and a degradation test (unreachable Redis still counts locally), plus a
mutation check on the shared-visibility property.

### 6. Features — MFA (TOTP) done 2026-08-26

Shipped as the `mfa` tickets: TOTP enrollment with AES-256-GCM-encrypted
secrets under a dedicated `ENCRYPTION_KEY` (ADR 0006), two-phase login
through a single-use, device-bound challenge token (social logins challenged
uniformly), single-use backup codes shown exactly once, step-up'd disable,
and password reset clearing enrollment as the lost-authenticator escape
hatch. Alongside it: an optional per-Project mandate — `enforce_mfa` plus
`mfa_grace_days` (owner-settable, clamped 3–90, default 7) — stamping each
unenrolled user a grace window at credential verification and refusing
walled requests everywhere except enrollment routes and logout. Contract
version bumped to 0.4.0; both SDKs learned the two-phase flow.

Deliberately ordered last: none of what remains was worth building before
the foundation above closed. Still open:

- Passkeys.
- RBAC enforcement. `Role` exists on the user, appears in no token, and gates
  nothing.
- Asymmetric access-token signing with `kid` and a key-rotation policy, if other
  services ever need to verify tokens without sharing the secret.

## Before starting the SDK — satisfied and shipped 2026-08-24

Kept as history: the gate (stable rotation/revocation rules, final token
transport, observable auth events, integration-test coverage, and ADR 0003's
versioned contract) was met via the ops-hardening tickets, and tickets 05/06
built both SDK packages against it. Any further contract change now flows
through ADR 0003's version-bump discipline rather than this gate.

## Deliberately not doing

- **Becoming an OIDC provider.** kauth authenticates users for first-party
  apps; it is not an identity provider other applications integrate against.
  This is a product decision, not a backlog item.
- **HIBP breach checking on passwords.** Declined 2026-08-24 alongside the
  Argon2id move: an auth service whose signup dies because a third-party API
  is down is an availability bug, and the check was defense-in-depth rather
  than the gate. Revisit only as an opt-in per-Project feature.
- **A DB-backed CSRF token.** The stateless signed approach is no weaker and
  costs no query. The leftover `csrf_tokens` table was dead schema and was
  dropped 2026-08-24 (tracker-hygiene ticket 01).
- **Caching the session lookup in `requireAuth`.** A cache reintroduces exactly
  the staleness window that binding tokens to sessions closed. Revisit only if
  profiling shows a real problem.

## Long-term direction

Recorded so future sessions don't design against it by accident:

- **Admin dashboard over `backend-sdk`.** The self-hosted management UI —
  Projects, rules, keys, audit views — is a skin over the same SECRET-key API
  calls operators make today. Nothing blocks it; it has simply not been built.
- **Per-Project databases eventually supersede the shared-table model**
  (ADR 0001), because the dashboard's natural end state — per-Project schema
  management — needs tenant-owned DDL blast radius. Deferred until that work
  starts; database-per-tenant vs schema-per-tenant deliberately undecided.
  Until then, schema is owned by the server alone: Projects configure
  behaviour through row-level settings (e.g. password policy), never DDL.
