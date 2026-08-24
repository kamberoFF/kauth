# Roadmap

**Living document.** Unlike the dated audit and remediation logs, this file is
kept current — if it disagrees with the code, the file is wrong.

Last reviewed: 2026-08-24.

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
the dead `csrf_tokens` table is dropped; and session policy
(server-issued device identity, sliding expiry, inactivity timeout) shipped
2026-08-24. **Next up: password hashing**, then multi-instance readiness.

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
- **Verification** — 247 integration tests against real Postgres covering abuse
  cases (reuse, revoked-session access, throttling, device mismatch, CSRF), run
  in CI alongside typecheck, lint, and `bun audit`.

## Next

Ordered by what unblocks or protects the most.

### 1. Operations — done 2026-08-24

Shipped as the `ops-hardening` tickets: non-root container with a liveness
healthcheck, migrate-on-startup with bounded graceful shutdown, structured
logging with request/user/session correlation, liveness/readiness split, and
the coordinated session/audit cleanup job (ADR 0004).

### 2. Password hashing

- Move to Argon2id, benchmarked to 250–400 ms on the deployment target.
- Migrate transparently by rehashing on successful login.
- Raise the minimum length toward NIST-4's 15 characters for single-factor, and
  add an HIBP breach check. The 72-byte cap can go once bcrypt does.

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

### 5. Multi-instance readiness

- The rate limiter's default store is per-process, so every limit becomes
  per-replica the moment kauth runs more than once. Needs a shared store.

### 6. Features

Deliberately last: none of them are worth building on a foundation that still
has the items above open.

- MFA (TOTP) and passkeys.
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
- **A DB-backed CSRF token.** The stateless signed approach is no weaker and
  costs no query. The leftover `csrf_tokens` table was dead schema and was
  dropped 2026-08-24 (tracker-hygiene ticket 01).
- **Caching the session lookup in `requireAuth`.** A cache reintroduces exactly
  the staleness window that binding tokens to sessions closed. Revisit only if
  profiling shows a real problem.
